"""
Semantic filtering using Voyage AI embeddings
Ranks page elements by relevance to user goal
Optimized with batch embedding and caching
"""
import logging
from typing import List, Dict, Any
import hashlib
import numpy as np
from app.config import settings

logger = logging.getLogger(__name__)

# Enable/disable semantic filtering
USE_SEMANTIC_FILTER = True
SIMILARITY_THRESHOLD = 0.3  # Minimum similarity score to include

# In-memory cache for embeddings (keyed by text hash)
_embedding_cache: Dict[str, List[float]] = {}


def _get_cache_key(text: str) -> str:
    """Generate cache key from text"""
    return hashlib.md5(text.encode('utf-8')).hexdigest()


async def _batch_embed_texts(texts: List[str]) -> List[List[float]]:
    """
    Batch embed multiple texts using Voyage AI
    Checks cache first, only embeds uncached texts
    """
    from app.services.embeddings import embed_text, EmbeddingsError
    import voyageai
    
    results = []
    to_embed = []
    to_embed_indices = []
    
    # Check cache first
    for i, text in enumerate(texts):
        cache_key = _get_cache_key(text)
        if cache_key in _embedding_cache:
            results.append(_embedding_cache[cache_key])
        else:
            results.append(None)  # Placeholder
            to_embed.append(text)
            to_embed_indices.append(i)
    
    # Batch embed uncached texts
    if to_embed:
        try:
            vo = voyageai.Client(api_key=settings.voyage_api_key)
            batch_result = vo.embed(to_embed, model="voyage-2")
            
            # Store in cache and results
            for idx, embedding in zip(to_embed_indices, batch_result.embeddings):
                results[idx] = embedding
                cache_key = _get_cache_key(to_embed[to_embed_indices.index(idx)])
                _embedding_cache[cache_key] = embedding
            
            logger.info(f"📦 Batch embedded {len(to_embed)} texts, {len(texts) - len(to_embed)} from cache")
        except Exception as e:
            logger.error(f"Batch embedding failed: {e}")
            # Fallback to individual embedding for uncached
            for idx in to_embed_indices:
                try:
                    embedding = await embed_text(texts[idx])
                    results[idx] = embedding
                    cache_key = _get_cache_key(texts[idx])
                    _embedding_cache[cache_key] = embedding
                except Exception:
                    results[idx] = [0.0] * 1024  # Neutral vector
    
    return results


async def semantic_filter_features(
    user_goal: str,
    features: List[Dict[str, Any]],
) -> Dict[str, List[Dict[str, Any]]]:
    """
    Filter and rank features by semantic similarity to user goal
    Returns top 20 from each category (inputs, buttons, links) - 60 total
    
    Args:
        user_goal: What the user wants to accomplish
        features: List of page features extracted from DOM
    
    Returns:
        Dict with filtered lists: {"inputs": [...], "buttons": [...], "links": [...]}
    """
    if not USE_SEMANTIC_FILTER or not features:
        # Group by type and return top 20 each
        by_type = {"input": [], "button": [], "link": []}
        for f in features:
            ftype = f.get("type", "link")
            by_type[ftype].append(f)
        return {
            "inputs": by_type["input"][:20],
            "buttons": by_type["button"][:20],
            "links": by_type["link"][:20]
        }
    
    try:
        logger.info(f"🔍 Semantic filtering {len(features)} features for goal: {user_goal[:50]}...")
        
        # Build text representations
        feature_texts = []
        for f in features:
            text_parts = [
                f.get('text', ''),
                f.get('placeholder', ''),
                f.get('aria_label', ''),
                f.get('href', '').split('/')[-1] if f.get('href') else ''
            ]
            combined_text = ' '.join([t for t in text_parts if t]).strip()
            feature_texts.append(combined_text[:500] or 'element')
        
        # Batch embed: goal + all features
        all_texts = [user_goal] + feature_texts
        all_embeddings = await _batch_embed_texts(all_texts)
        
        goal_embedding = np.array(all_embeddings[0])
        feature_embeddings = [np.array(e) for e in all_embeddings[1:]]
        
        # Calculate similarities with smart weighting
        similarities = []
        pagination_keywords = ['next', 'previous', 'prev', 'page ', ' page', 'pagination']
        category_keywords = ['men', 'women', 'woman', 'mens', 'womens', 'shop', 'category', 
                            'collection', 'apparel', 'clothing', 'accessories', 'jewelry', 
                            'shoes', 'dress', 'skirt', 'pant', 'shirt', 'top', 'bottom']
        action_keywords = ['add to cart', 'add to bag', 'buy now', 'purchase', 'checkout', 
                          'add', 'submit', 'continue', 'proceed', 'confirm', 'place order']
        menu_keywords = ['menu', 'navigation', 'nav', 'hamburger', 'close', 'open menu']
        product_keywords = ['product', 'item', '$', 'price', 'shop', 'quick view', 'quick add',
                           'trouser', 'pant', 'skirt', 'dress', 'shirt', 'shoe', 'jacket']
        
        for i, feature_emb in enumerate(feature_embeddings):
            similarity = np.dot(goal_embedding, feature_emb) / (
                np.linalg.norm(goal_embedding) * np.linalg.norm(feature_emb) + 1e-8
            )
            
            # Apply smart weighting
            feature = features[i]
            text_lower = (feature.get('text', '') + ' ' + feature.get('aria_label', '') + ' ' + feature.get('href', '')).lower()
            
            # Strong penalty for pagination to avoid loops
            is_pagination = any(kw in text_lower for kw in pagination_keywords)
            if is_pagination and feature.get('type') == 'link':
                similarity *= 0.2  # Very strong penalty
            
            # Boost category/navigation links (they lead to product pages)
            is_category = any(kw in text_lower for kw in category_keywords)
            if is_category and feature.get('type') == 'link' and not is_pagination:
                similarity *= 1.5  # Boost navigation links
            
            # STRONG boost for product links (actual items for sale)
            is_product = any(kw in text_lower for kw in product_keywords)
            if is_product and feature.get('type') == 'link' and not is_pagination:
                similarity *= 2.5  # Very strong boost for product links
            
            # STRONG boost for action buttons (add to cart, buy now, etc.)
            is_action = any(kw in text_lower for kw in action_keywords)
            if is_action and feature.get('type') in ['button', 'link']:
                similarity *= 2.0  # Very strong boost for action buttons
            
            # Penalty for menu/nav buttons to avoid clicking them
            is_menu = any(kw in text_lower for kw in menu_keywords)
            if is_menu and feature.get('type') == 'button':
                similarity *= 0.1  # Very strong penalty for menu buttons
            
            similarities.append((i, float(similarity), features[i]))
        
        # Group by type and sort each
        by_type = {"input": [], "button": [], "link": []}
        for idx, score, feature in similarities:
            ftype = feature.get("type", "link")
            feature['_similarity_score'] = score
            by_type[ftype].append((score, feature))
        
        # Sort each category and take top 20
        result = {}
        for ftype in ["input", "button", "link"]:
            sorted_items = sorted(by_type[ftype], key=lambda x: x[0], reverse=True)
            # Filter by threshold and take top 20
            filtered = [item[1] for item in sorted_items if item[0] >= SIMILARITY_THRESHOLD][:20]
            # If too few, add lower-scoring ones
            if len(filtered) < 10 and len(sorted_items) > len(filtered):
                remaining = [item[1] for item in sorted_items[len(filtered):]][:10 - len(filtered)]
                filtered.extend(remaining)
            result[ftype + "s"] = filtered  # "inputs", "buttons", "links"
        
        total_sent = sum(len(v) for v in result.values())
        top_score = max(similarities, key=lambda x: x[1])[1] if similarities else 0
        logger.info(f"✅ Semantic filter: {len(features)} → {total_sent} features (top score: {top_score:.3f})")
        logger.info(f"   📊 Breakdown: {len(result['inputs'])} inputs, {len(result['buttons'])} buttons, {len(result['links'])} links")
        
        return result
        
    except Exception as e:
        logger.error(f"Semantic filtering failed: {e}", exc_info=True)
        # Fallback grouping
        by_type = {"input": [], "button": [], "link": []}
        for f in features:
            ftype = f.get("type", "link")
            by_type[ftype].append(f)
        return {
            "inputs": by_type["input"][:20],
            "buttons": by_type["button"][:20],
            "links": by_type["link"][:20]
        }

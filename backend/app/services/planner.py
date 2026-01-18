from __future__ import annotations

import json
import logging
from typing import List

from pydantic import ValidationError

from app.config import settings
from app.models import PageFeature, PlannedStep
from app.utils.helpers import JSONParseError, extract_json_object
from app.utils.rate_limiter import call_with_retry, RateLimitError

logger = logging.getLogger(__name__)

# Flag to enable/disable Backboard.io (can fallback to OpenAI if needed)
USE_BACKBOARD = True


class PlannerError(RuntimeError):
    pass


def build_planner_prompt(user_goal: str, initial_features: list, url: str, page_title: str = "") -> str:
    features = [
        {
            "index": f.get("index") if isinstance(f, dict) else f.index,
            "type": f.get("type") if isinstance(f, dict) else f.type,
            "text": f.get("text", "") if isinstance(f, dict) else (f.text or ""),
            "placeholder": f.get("placeholder", "") if isinstance(f, dict) else (getattr(f, "placeholder", "") or ""),
            "aria_label": f.get("aria_label", "") if isinstance(f, dict) else (getattr(f, "aria_label", "") or ""),
            "href": f.get("href", "") if isinstance(f, dict) else (getattr(f, "href", "") or ""),
            "selector": f.get("selector", "") if isinstance(f, dict) else (f.selector or ""),
            "already_clicked": f.get("already_clicked", False) if isinstance(f, dict) else getattr(f, "already_clicked", False),
        }
        for f in initial_features[:20]  # Reduced for speed
    ]
    features_json = json.dumps(features, ensure_ascii=False)

    return f"""
You are a precise web automation planner.

GOAL: {user_goal}
PAGE_TITLE: {page_title}
URL: {url}
ELEMENTS_JSON: {features_json}

CRITICAL RULES:
- FIRST: Check if the current URL and PAGE_TITLE indicate the goal is already achieved or very close
  - If URL contains keywords matching the goal (e.g., goal is "women's clothing" and URL has "/collections/apparel" or "/woman"), the task may be COMPLETE
  - If we're already on the target page, use DONE action immediately - do NOT click navigation links again
  - Example: Goal "go to women's clothing" + URL "leifshop.com/collections/apparel" = Already there, use DONE
- ALREADY CLICKED ELEMENTS: Some elements have "already_clicked": true
  - STRONGLY PREFER elements where already_clicked is false or missing
  - Only click already_clicked elements if there are NO OTHER viable options
  - If you must click an already_clicked element, verify it's truly necessary for the goal
  - This helps avoid infinite loops while still allowing necessary repeated clicks
- Use ONLY elements from ELEMENTS_JSON. Do NOT invent buttons/fields that aren't listed.
- Do NOT output a generic "search the web" plan unless the GOAL explicitly asks to search.
- If the current URL is unrelated to the goal (wrong site/tab), your first steps MUST be MANUAL (cannot be highlighted):
  - Use action=WAIT with expected_page_change=true and describe exactly what the user should do:
    1) Open a new tab
    2) Click the address bar
    3) Type the correct URL and press Enter
  - When you tell the user to go to a URL, you MUST include the full URL on its own line, so the user can copy and paste the link to use, or press on it to get to the correct site.
- Never propose creating/signing into accounts for unrelated services just because you're currently on their page (e.g., Google Account).
- When you reach the correct site, use ELEMENTS_JSON to decide what to do:
  - If elements suggest the user is already logged in (e.g. "Log out", "Settings", profile/account links), plan steps to log out first.
  - Otherwise plan steps to create a new account (sign up).
- Each step must be one atomic action: CLICK, TYPE, SCROLL, WAIT, DONE.
- AVOID LOOPS: If a single action would complete the goal (e.g., clicking one navigation link), generate ONLY that action followed by DONE
  - Never generate multiple identical or redundant steps
  - After clicking a navigation link, the next plan should recognize the URL changed and either continue or finish
  - PAGINATION WARNING: NEVER repeatedly click "next", "previous", or page number links without a specific reason
  - If you need to find items, use category navigation (e.g., Women > Skirts) or search instead of pagination
  - Clicking "next" should only be a last resort if the specific item/category is not found on the current page
- NAVIGATION STRATEGY: When looking for specific items (e.g., "buy skirts", "find jewelry"):
  - PREFER: Category navigation links (Women > Skirts, Shop > Accessories)
  - SECOND CHOICE: Search functionality (type query, then click search)
  - LAST RESORT: Pagination (clicking "next" to browse pages)
- SEARCH HANDLING: When the goal involves searching (e.g., "buy hats", "find jewelry"):
  - DO NOT repeatedly click search links/buttons without typing first
  - Look for INPUT elements with type="input" and placeholder/aria_label containing "search"
  - First: TYPE action targeting the search input field with the search query
  - Then: CLICK action on the search button or press enter
  - Never skip the TYPE step when a search is needed
- Every CLICK/TYPE step MUST include target_hints with:
  - type (input/button/link)
  - AND at least one anchor: text_contains OR placeholder_contains OR selector_pattern.
- In target_hints, text_contains and placeholder_contains MUST be JSON arrays (use [] if none). Never use null.
- TYPE steps MUST include text_input.
  - If the goal requires unknown personal info (email/phone/password), use placeholders like "<EMAIL>", "<PASSWORD>" and say so in the description.
  - For search queries, extract the search term from the goal (e.g., "hats" from "buy hats")
- End the plan with a DONE step.

OUTPUT:
Return JSON only, exactly:
{{
  "steps": [
    {{
      "step_number": 1,
      "action": "CLICK|TYPE|SCROLL|WAIT|DONE",
      "description": "...",
      "target_hints": {{
        "type": "input|button|link",
        "text_contains": ["..."],
        "placeholder_contains": ["..."],
        "selector_pattern": null,
        "role": null
      }},
      "text_input": null,
      "expected_page_change": false
    }}
  ]
}}
""".strip()

def parse_planner_steps(raw_text: str) -> List[PlannedStep]:
    try:
        data = extract_json_object(raw_text)
    except JSONParseError as e:
        raise PlannerError(f"Planner returned non-JSON output: {e}") from e

    steps = data.get("steps")
    if not isinstance(steps, list) or not steps:
        raise PlannerError("Planner output missing non-empty 'steps' list")

    parsed: List[PlannedStep] = []
    for i, step in enumerate(steps):
        try:
            parsed.append(PlannedStep.model_validate(step))
        except ValidationError as e:
            raise PlannerError(f"Invalid step at index {i}: {e}") from e

    parsed.sort(key=lambda s: s.step_number)
    return parsed


def _call_openai_sync(prompt: str) -> str:
    """
    Synchronous OpenAI call (wrapped by rate limiter).
    """
    from openai import OpenAI  # type: ignore

    client = OpenAI(api_key=settings.openai_api_key)
    response = client.chat.completions.create(
        model="gpt-4o-mini",  # Fast and cheap model
        messages=[
            {"role": "user", "content": prompt}
        ],
        temperature=0.2,
    )
    return response.choices[0].message.content or ""


async def generate_workflow_plan(
    user_goal: str, initial_features: List[PageFeature], url: str, page_title: str = "", user_id: str = None
) -> List[PlannedStep]:
    """
    Use Backboard.io (or OpenAI fallback) to generate complete step-by-step workflow.
    Implements multi-model switching and adaptive memory for Backboard.io challenge.
    Includes rate limiting and retry logic.
    Now with semantic filtering using Voyage AI!
    """
    # Apply semantic filtering to focus on relevant elements
    from app.services.semantic_filter import semantic_filter_features
    
    try:
        # Convert PageFeatures to dicts for semantic filtering
        features_dict = [
            {
                "selector": getattr(f, "selector", ""),
                "index": f.index,
                "type": f.type,
                "text": f.text or "",
                "placeholder": getattr(f, "placeholder", "") or "",
                "aria_label": getattr(f, "aria_label", "") or "",
                "href": getattr(f, "href", "") or "",
                "value": getattr(f, "value", "") or "",
                "already_clicked": getattr(f, "already_clicked", False),
            }
            for f in initial_features[:110]  # Limit to 110 for embedding efficiency
        ]
        
        # Semantic filtering - returns top 25 from each category (inputs, buttons, links)
        filtered_by_type = await semantic_filter_features(user_goal, features_dict)
        # Flatten back to single list
        filtered_features = (
            filtered_by_type.get("inputs", []) +
            filtered_by_type.get("buttons", []) +
            filtered_by_type.get("links", [])
        )
        # Count by category
        input_count = len(filtered_by_type.get("inputs", []))
        button_count = len(filtered_by_type.get("buttons", []))
        link_count = len(filtered_by_type.get("links", []))
        logger.info(f"📊 Semantic filter: {len(features_dict)} → {len(filtered_features)} features ({input_count}i + {button_count}b + {link_count}l)")
        
        # Log what elements are being sent to the AI
        logger.info("=" * 80)
        logger.info("🔍 ELEMENTS BEING SENT TO AI:")
        logger.info(f"Goal: {user_goal}")
        logger.info(f"URL: {url}")
        logger.info(f"📦 Sending: {input_count} inputs, {button_count} buttons, {link_count} links (max 75 total)")
        logger.info("-" * 80)
        
        # Show inputs first
        logger.info("📝 INPUTS:")
        for idx, feat in enumerate(filtered_by_type.get("inputs", [])[:15], 1):
            score = feat.get('_similarity_score', 0.0)
            text = feat.get('text', '')[:40] or feat.get('placeholder', '')[:40]
            clicked = "✓" if feat.get('already_clicked') else " "
            logger.info(f"  {idx:2d}. [{clicked}] {text:40s} (score: {score:.3f})")
        
        # Show buttons
        logger.info("🔘 BUTTONS:")
        for idx, feat in enumerate(filtered_by_type.get("buttons", [])[:15], 1):
            score = feat.get('_similarity_score', 0.0)
            text = feat.get('text', '')[:40]
            clicked = "✓" if feat.get('already_clicked') else " "
            logger.info(f"  {idx:2d}. [{clicked}] {text:40s} (score: {score:.3f})")
        
        # Show links
        logger.info("🔗 LINKS:")
        for idx, feat in enumerate(filtered_by_type.get("links", [])[:20], 1):
            score = feat.get('_similarity_score', 0.0)
            text = feat.get('text', '')[:40] or feat.get('href', '')[:40]
            clicked = "✓" if feat.get('already_clicked') else " "
            logger.info(f"  {idx:2d}. [{clicked}] {text:40s} (score: {score:.3f})")
        
        logger.info("=" * 80)
    except Exception as e:
        logger.warning(f"Semantic filtering failed, using smart fallback: {e}")
        # Fallback: top 30 from each category without semantic ranking
        by_type = {"input": [], "button": [], "link": []}
        for f in initial_features[:110]:
            ftype = f.type
            by_type[ftype].append({
                "selector": getattr(f, "selector", ""),
                "index": f.index,
                "type": f.type,
                "text": f.text or "",
                "placeholder": getattr(f, "placeholder", "") or "",
                "aria_label": getattr(f, "aria_label", "") or "",
                "href": getattr(f, "href", "") or "",
                "value": getattr(f, "value", "") or "",
                "already_clicked": getattr(f, "already_clicked", False),
            })
        filtered_features = by_type["input"][:30] + by_type["button"][:30] + by_type["link"][:30]
    
    prompt = build_planner_prompt(user_goal=user_goal, initial_features=filtered_features, url=url, page_title=page_title)

    # Log what's being sent
    logger.info("=" * 60)
    logger.info("AI PLANNER REQUEST (Backboard.io Multi-Model)")
    logger.info("=" * 60)
    logger.info(f"User Goal: {user_goal}")
    logger.info(f"User ID: {user_id or 'anonymous'}")
    logger.info(f"URL: {url}")
    logger.info(f"Features count: {len(initial_features)}")
    logger.info(f"Using Backboard: {USE_BACKBOARD}")
    logger.info(f"Backboard API Key set: {bool(settings.backboard_api_key)}")
    logger.info(f"Backboard API Key value: {settings.backboard_api_key[:20]}..." if settings.backboard_api_key else "None")
    logger.info("-" * 60)

    try:
        if USE_BACKBOARD and settings.backboard_api_key and settings.backboard_api_key != "your_backboard_api_key_here":
            # Use Backboard.io with multi-model support and adaptive memory
            try:
                from app.services.backboard_ai import backboard_ai
                
                logger.info("✅ Using Backboard.io multi-model AI")
                
                text = await backboard_ai.generate_plan(
                    user_goal=user_goal,
                    page_features=filtered_features,  # Already filtered semantically
                    url=url,
                    page_title=page_title,
                    user_id=user_id
                )
                logger.info("✅ Backboard.io response received")
            except Exception as backboard_error:
                logger.error(f"❌ Backboard.io failed: {backboard_error}", exc_info=True)
                logger.info("⚠️ Falling back to OpenAI")
                text = await call_with_retry(_call_openai_sync, prompt)
        else:
            # Fallback to OpenAI
            logger.info("Using OpenAI fallback (Backboard not configured)")
            text = await call_with_retry(_call_openai_sync, prompt)
        
        # Log AI response
        logger.info("-" * 60)
        logger.info("AI RESPONSE:")
        logger.info(text)
        logger.info("=" * 60)
        
        return parse_planner_steps(text)
    except RateLimitError as e:
        raise PlannerError(str(e)) from e
    except PlannerError:
        raise
    except Exception as e:  # pragma: no cover (SDK errors vary)
        logger.exception("AI planner call failed")
        raise PlannerError(str(e)) from e

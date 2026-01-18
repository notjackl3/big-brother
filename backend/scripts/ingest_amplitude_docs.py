#!/usr/bin/env python3
"""
Ingest Amplitude Documentation into Context Graph

This script crawls Amplitude's documentation and extracts:
1. DocPages with content chunks
2. Procedures with step-by-step instructions
3. UI state requirements for each step

Usage:
    cd backend
    source venv/bin/activate
    python scripts/ingest_amplitude_docs.py
"""

import asyncio
import sys
import os
import re
import logging
from typing import List, Dict, Any, Optional
from urllib.parse import urljoin, urlparse

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

from app.services.graph import graph_service
from app.services.doc_ingestion import (
    crawl_docs,
    chunk_page,
    embed_text,
    extract_procedures
)


# Amplitude documentation structure
AMPLITUDE_DOCS = {
    "root_url": "https://amplitude.com/docs",
    "key_pages": [
        # Getting Started
        "https://amplitude.com/docs/get-started",
        "https://amplitude.com/docs/get-started/create-your-organization-and-first-project",
        "https://amplitude.com/docs/get-started/send-your-first-event",
        
        # Analytics
        "https://amplitude.com/docs/analytics",
        "https://amplitude.com/docs/analytics/charts",
        "https://amplitude.com/docs/analytics/charts/event-segmentation",
        "https://amplitude.com/docs/analytics/charts/funnel-analysis",
        "https://amplitude.com/docs/analytics/charts/retention-analysis",
        
        # Data
        "https://amplitude.com/docs/data",
        "https://amplitude.com/docs/data/sources",
        "https://amplitude.com/docs/data/destinations",
        
        # SDKs
        "https://amplitude.com/docs/sdks",
        "https://amplitude.com/docs/sdks/analytics/browser/browser-sdk-2",
        "https://amplitude.com/docs/sdks/analytics/ios/ios-swift-sdk",
        "https://amplitude.com/docs/sdks/analytics/android/android-kotlin-sdk",
    ]
}

# Pre-defined procedures for Amplitude (extracted from docs)
AMPLITUDE_PROCEDURES = [
    {
        "goal": "Create a new Amplitude project",
        "description": "Set up a new project in Amplitude to start tracking events",
        "steps": [
            {
                "instruction": "Go to Amplitude and log in to your account",
                "action_type": "navigate",
                "url": "https://analytics.amplitude.com",
                "expected_state": "Login page or dashboard"
            },
            {
                "instruction": "Click on the project dropdown in the top navigation",
                "action_type": "click",
                "selector_hint": "[data-testid='project-switcher'], .project-dropdown, button:contains('Project')",
                "expected_state": "Project dropdown menu visible"
            },
            {
                "instruction": "Click 'Create New Project' or 'New Project' button",
                "action_type": "click",
                "selector_hint": "button:contains('Create'), button:contains('New Project')",
                "expected_state": "New project creation form"
            },
            {
                "instruction": "Enter the project name in the input field",
                "action_type": "type",
                "selector_hint": "input[name='projectName'], input[placeholder*='name']",
                "expected_state": "Project name entered"
            },
            {
                "instruction": "Select the data region (US or EU)",
                "action_type": "click",
                "selector_hint": "select[name='region'], .region-selector",
                "expected_state": "Region selected"
            },
            {
                "instruction": "Click 'Create Project' to finalize",
                "action_type": "click",
                "selector_hint": "button[type='submit'], button:contains('Create Project')",
                "expected_state": "Project created, dashboard shown"
            }
        ]
    },
    {
        "goal": "Create an event segmentation chart",
        "description": "Build a chart to analyze event data over time",
        "steps": [
            {
                "instruction": "Click 'Product Analytics' in the left sidebar to expand the menu",
                "action_type": "click",
                "selector_hint": "button:contains('Product Analytics'), span:contains('Product Analytics')",
                "expected_state": "Product Analytics menu expanded"
            },
            {
                "instruction": "Click 'Create' button in the top navigation bar",
                "action_type": "click",
                "selector_hint": "button:contains('Create'), [data-testid='create-button']",
                "expected_state": "Create menu opens"
            },
            {
                "instruction": "Click 'Segmentation' to select Event Segmentation chart type",
                "action_type": "click",
                "selector_hint": "button:contains('Segmentation'), a:contains('Segmentation'), span:contains('Segmentation')",
                "expected_state": "Segmentation chart builder opens"
            },
            {
                "instruction": "Click '+ Add Event' to add an event to analyze",
                "action_type": "click",
                "selector_hint": "button:contains('Add Event'), span:contains('Add Event')",
                "expected_state": "Event picker opens"
            },
            {
                "instruction": "Click on an event name from the dropdown list",
                "action_type": "click",
                "selector_hint": ".event-list-item, .event-option, [role='option']",
                "expected_state": "Event selected"
            }
        ]
    },
    {
        "goal": "Create a funnel analysis",
        "description": "Build a funnel to track conversion through a series of steps",
        "steps": [
            {
                "instruction": "Click 'Product Analytics' in the left sidebar to expand the menu",
                "action_type": "click",
                "selector_hint": "a[href*='analytics'], button:contains('Product Analytics'), span:contains('Product Analytics')",
                "expected_state": "Product Analytics menu expanded"
            },
            {
                "instruction": "Click 'Create' button in the top navigation bar",
                "action_type": "click",
                "selector_hint": "button:contains('Create'), [data-testid='create-button']",
                "expected_state": "Create menu opens"
            },
            {
                "instruction": "Click 'Funnel' to select Funnel Analysis chart type",
                "action_type": "click",
                "selector_hint": "button:contains('Funnel'), a:contains('Funnel'), span:contains('Funnel')",
                "expected_state": "Funnel chart builder opens"
            },
            {
                "instruction": "Click 'Add Event' or '+ Add Event' to add the first funnel step",
                "action_type": "click",
                "selector_hint": "button:contains('Add Event'), button:contains('+ Add')",
                "expected_state": "Event picker opens"
            },
            {
                "instruction": "Click on an event name from the dropdown list",
                "action_type": "click",
                "selector_hint": ".event-option, .event-list-item, [role='option']",
                "expected_state": "Event selected"
            },
            {
                "instruction": "Click '+ Add Event' button to add another step",
                "action_type": "click",
                "selector_hint": "button:contains('Add Event'), button:contains('+ Add'), span:contains('Add Event')",
                "expected_state": "Second event picker opens"
            },
            {
                "instruction": "Click on another event name from the dropdown list",
                "action_type": "click",
                "selector_hint": ".event-option, .event-list-item, [role='option']",
                "expected_state": "Second event selected"
            }
        ]
    },
    {
        "goal": "Set up retention analysis",
        "description": "Analyze how users return to your product over time",
        "steps": [
            {
                "instruction": "Go to Analytics section",
                "action_type": "click",
                "selector_hint": "a[href*='analytics']",
                "expected_state": "Analytics page"
            },
            {
                "instruction": "Create a new chart",
                "action_type": "click",
                "selector_hint": "button:contains('New Chart')",
                "expected_state": "Chart selection"
            },
            {
                "instruction": "Select 'Retention Analysis'",
                "action_type": "click",
                "selector_hint": ".chart-type:contains('Retention'), button:contains('Retention')",
                "expected_state": "Retention builder"
            },
            {
                "instruction": "Configure the starting event (what counts as 'Day 0')",
                "action_type": "click",
                "selector_hint": ".starting-event-selector, button:contains('Starting Event')",
                "expected_state": "Event selection"
            },
            {
                "instruction": "Select your activation event",
                "action_type": "click",
                "selector_hint": ".event-option",
                "expected_state": "Starting event set"
            },
            {
                "instruction": "Configure the return event (what counts as 'returned')",
                "action_type": "click",
                "selector_hint": ".return-event-selector, button:contains('Return Event')",
                "expected_state": "Return event selection"
            },
            {
                "instruction": "Click 'Run' to generate retention curve",
                "action_type": "click",
                "selector_hint": "button:contains('Run')",
                "expected_state": "Retention curve displayed"
            }
        ]
    },
    {
        "goal": "Install Amplitude Browser SDK",
        "description": "Add Amplitude tracking to your web application",
        "steps": [
            {
                "instruction": "Go to Data section in Amplitude",
                "action_type": "click",
                "selector_hint": "a[href*='data'], nav a:contains('Data')",
                "expected_state": "Data management page"
            },
            {
                "instruction": "Click on 'Sources' to manage data sources",
                "action_type": "click",
                "selector_hint": "a[href*='sources'], button:contains('Sources')",
                "expected_state": "Sources page"
            },
            {
                "instruction": "Click 'Add Source' to set up a new data source",
                "action_type": "click",
                "selector_hint": "button:contains('Add Source'), button:contains('New Source')",
                "expected_state": "Source type selection"
            },
            {
                "instruction": "Select 'Browser SDK' from the options",
                "action_type": "click",
                "selector_hint": ".source-option:contains('Browser'), button:contains('JavaScript')",
                "expected_state": "SDK setup instructions"
            },
            {
                "instruction": "Copy your API key from the setup page",
                "action_type": "click",
                "selector_hint": "button:contains('Copy'), .copy-button",
                "expected_state": "API key copied"
            }
        ]
    },
    {
        "goal": "Create a user cohort",
        "description": "Define a group of users based on behavior",
        "steps": [
            {
                "instruction": "Navigate to the Cohorts section",
                "action_type": "click",
                "selector_hint": "a[href*='cohorts'], nav a:contains('Cohorts')",
                "expected_state": "Cohorts page"
            },
            {
                "instruction": "Click 'New Cohort' to create a cohort",
                "action_type": "click",
                "selector_hint": "button:contains('New Cohort'), button:contains('Create')",
                "expected_state": "Cohort builder"
            },
            {
                "instruction": "Define the cohort criteria by selecting events or properties",
                "action_type": "click",
                "selector_hint": ".criteria-selector, button:contains('Add Criteria')",
                "expected_state": "Criteria selection"
            },
            {
                "instruction": "Choose the behavioral criteria (e.g., 'performed event X')",
                "action_type": "click",
                "selector_hint": ".criteria-option, .event-selector",
                "expected_state": "Criteria added"
            },
            {
                "instruction": "Name your cohort",
                "action_type": "type",
                "selector_hint": "input[name='cohortName'], input[placeholder*='name']",
                "expected_state": "Cohort named"
            },
            {
                "instruction": "Click 'Save Cohort' to save",
                "action_type": "click",
                "selector_hint": "button:contains('Save'), button[type='submit']",
                "expected_state": "Cohort saved"
            }
        ]
    }
]


async def ingest_amplitude_docs():
    """Main function to ingest Amplitude documentation."""
    
    print("=" * 60)
    print("AMPLITUDE DOCS INGESTION")
    print("=" * 60)
    
    # Step 1: Verify Neo4j connection
    print("\n[Step 1] Verifying Neo4j connection...")
    if not graph_service.verify_connectivity():
        print("❌ Neo4j is not available. Please start Neo4j first.")
        print("   Run: docker run -d --name neo4j -p 7474:7474 -p 7687:7687 -e NEO4J_AUTH=neo4j/password neo4j:5")
        return
    print("✅ Neo4j connected")
    
    # Step 2: Setup schema
    print("\n[Step 2] Setting up Neo4j schema...")
    graph_service.setup_schema()
    graph_service.setup_vector_index()
    print("✅ Schema setup complete")
    
    # Step 3: Create Amplitude company
    print("\n[Step 3] Creating Amplitude company...")
    company = graph_service.create_company(
        name="Amplitude Analytics",
        domain="amplitude.com"
    )
    company_id = company["id"]
    print(f"✅ Created company: {company['name']} (ID: {company_id})")
    
    # Step 4: Create documentation source
    print("\n[Step 4] Creating documentation source...")
    doc_source = graph_service.create_doc_source(
        company_id=company_id,
        source_type="url",
        root_url="https://amplitude.com/docs"
    )
    print(f"✅ Created doc source: {doc_source['id']}")
    
    # Step 5: Create a documentation page for procedures first
    print("\n[Step 5] Creating documentation page for procedures...")
    
    # Create a doc page to link procedures to
    procedures_page = graph_service.create_doc_page(
        source_id=doc_source["id"],
        url="https://amplitude.com/docs/procedures",
        title="Amplitude How-To Procedures",
        text="Step-by-step procedures for common Amplitude tasks",
        headings=["Getting Started", "Analytics", "Data Management"]
    )
    print(f"✅ Created procedures page: {procedures_page['id']}")
    
    # Step 6: Ingest pre-defined procedures
    print("\n[Step 6] Ingesting Amplitude procedures...")
    procedures_created = 0
    
    for proc_data in AMPLITUDE_PROCEDURES:
        try:
            # Generate embedding for the goal
            goal_embedding = embed_text(proc_data["goal"] + " " + proc_data.get("description", ""))
            
            # Create procedure linked to the doc page
            procedure = graph_service.create_procedure(
                page_id=procedures_page["id"],
                goal=proc_data["goal"],
                goal_embedding=goal_embedding,
                source_text=proc_data.get("description", "")
            )
            
            if procedure:
                procedures_created += 1
                print(f"   ✅ Procedure: {proc_data['goal']}")
                
                # Create steps for this procedure
                step_ids = []
                for idx, step_data in enumerate(proc_data["steps"]):
                    # Create step
                    step = graph_service.create_step(
                        procedure_id=procedure["id"],
                        step_index=idx,
                        instruction=step_data["instruction"],
                        action_type=step_data["action_type"],
                        selector_hint=step_data.get("selector_hint", ""),
                        expected_state=step_data.get("expected_state", "")
                    )
                    
                    if step:
                        step_ids.append(step["id"])
                
                # Link steps sequentially
                if len(step_ids) >= 2:
                    graph_service.link_steps_sequential(step_ids)
                
                print(f"      └─ {len(proc_data['steps'])} steps created")
        
        except Exception as e:
            print(f"   ❌ Failed to create procedure '{proc_data['goal']}': {e}")
    
    print(f"\n✅ Created {procedures_created} procedures")
    
    # Step 7: Create documentation chunks for key concepts
    print("\n[Step 7] Creating documentation chunks...")
    
    amplitude_concepts = [
        {
            "title": "Event Tracking Basics",
            "content": """
            Amplitude tracks user behavior through events. An event represents a single action 
            a user takes in your product, like 'Button Clicked' or 'Purchase Completed'.
            
            Key concepts:
            - Events: Actions users take (e.g., 'Sign Up', 'Add to Cart')
            - Event Properties: Additional data about events (e.g., item_name, price)
            - User Properties: Persistent attributes about users (e.g., plan_type, country)
            - Sessions: Groups of events within a time window
            
            To track an event:
            1. Initialize the Amplitude SDK
            2. Call amplitude.track('Event Name', { properties })
            """,
            "url": "https://amplitude.com/docs/get-started/send-your-first-event"
        },
        {
            "title": "Charts and Analytics",
            "content": """
            Amplitude provides several chart types for analyzing user behavior:
            
            1. Event Segmentation: See how often events occur over time
            2. Funnel Analysis: Track conversion through a series of steps
            3. Retention Analysis: Measure how users return over time
            4. User Composition: Understand user demographics and properties
            5. Pathfinder: Discover user navigation patterns
            
            To create a chart:
            1. Go to Analytics
            2. Click 'New Chart'
            3. Select chart type
            4. Configure events and filters
            5. Click 'Run'
            """,
            "url": "https://amplitude.com/docs/analytics/charts"
        },
        {
            "title": "Cohorts and Segmentation",
            "content": """
            Cohorts are groups of users who share common characteristics or behaviors.
            
            Types of cohorts:
            - Behavioral cohorts: Users who performed specific events
            - Property cohorts: Users with specific attributes
            - Computed cohorts: Dynamic groups based on formulas
            
            Use cohorts to:
            - Compare behavior across user segments
            - Target specific users for analysis
            - Sync users to external tools (ads, email)
            """,
            "url": "https://amplitude.com/docs/analytics/cohorts"
        },
        {
            "title": "Data Management",
            "content": """
            Amplitude's Data section helps you manage your tracking implementation:
            
            - Sources: Where data comes from (SDKs, APIs, integrations)
            - Destinations: Where to send data (data warehouses, tools)
            - Taxonomy: Event and property definitions
            - Governance: Data quality and schema management
            
            Best practices:
            1. Define a naming convention for events
            2. Document event properties
            3. Use taxonomy to enforce schema
            4. Monitor data quality regularly
            """,
            "url": "https://amplitude.com/docs/data"
        }
    ]
    
    chunks_created = 0
    for concept in amplitude_concepts:
        try:
            # Create a doc page for this concept
            doc_page = graph_service.create_doc_page(
                source_id=doc_source["id"],
                url=concept["url"],
                title=concept["title"],
                text=concept["content"],
                headings=[concept["title"]]
            )
            
            if doc_page:
                # Chunk the content
                chunks = chunk_page(concept["content"], headings_aware=True)
                
                for i, chunk_text_content in enumerate(chunks):
                    # Generate embedding
                    embedding = embed_text(chunk_text_content)
                    
                    # Create chunk
                    chunk = graph_service.create_chunk(
                        page_id=doc_page["id"],
                        text=chunk_text_content,
                        embedding=embedding,
                        chunk_index=i,
                        heading=concept["title"]
                    )
                    
                    if chunk:
                        chunks_created += 1
                
                print(f"   ✅ {concept['title']} ({len(chunks)} chunks)")
        
        except Exception as e:
            print(f"   ❌ Failed to create chunk for '{concept['title']}': {e}")
    
    print(f"\n✅ Created {chunks_created} documentation chunks")
    
    # Summary
    print("\n" + "=" * 60)
    print("AMPLITUDE DOCS INGESTION COMPLETE")
    print("=" * 60)
    print(f"""
Summary:
  - Company ID: {company_id}
  - Procedures: {procedures_created}
  - Documentation chunks: {chunks_created}

The AI agent can now:
  1. Navigate Amplitude using the ingested procedures
  2. Answer questions using the documentation chunks
  3. Record decision traces for audit

Test with:
  curl -X POST http://localhost:8000/api/companies/{company_id}/procedures
    """)
    
    return company_id


if __name__ == "__main__":
    asyncio.run(ingest_amplitude_docs())

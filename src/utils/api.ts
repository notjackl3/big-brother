// Backend API client for the tutor agent

const API_BASE_URL = 'http://localhost:8000';

export interface PageFeature {
  index: number;
  type: 'input' | 'button' | 'link';
  text: string;
  selector: string;
  href?: string;
  placeholder?: string;
  aria_label?: string;
  value_len?: number;
  already_clicked?: boolean;
}

export interface TargetHints {
  type?: string;
  text_contains?: string[];
  placeholder_contains?: string[];
  selector_pattern?: string;
  role?: string;
}

export interface PlannedStep {
  step_number: number;
  action: 'CLICK' | 'TYPE' | 'SCROLL' | 'WAIT' | 'DONE';
  description: string;
  target_hints: TargetHints;
  text_input?: string;
  expected_page_change: boolean;
}

export interface StartSessionRequest {
  user_goal: string;
  initial_page_features: PageFeature[];
  url: string;
  page_title: string;
}

export interface FirstStepInfo {
  step_number: number;
  action: string;
  target_feature_index: number | null;
  instruction: string;
  confidence: number;
}

export interface StartSessionResponse {
  session_id: string;
  planned_steps: PlannedStep[];
  total_steps: number;
  first_step: FirstStepInfo;
}

export interface NextActionRequest {
  session_id: string;
  page_features: PageFeature[];
  url?: string;
  page_title?: string;
  previous_action_result?: {
    success: boolean;
    error?: string;
  };
}

export interface NextActionResponse {
  step_number: number;
  total_steps: number;
  action: string;
  target_feature_index: number | null;
  target_feature: PageFeature | null;
  instruction: string;
  text_input?: string;
  confidence: number;
  expected_page_change: boolean;
  session_complete: boolean;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Start a new tutoring session - sends goal + page features to backend
 * Backend calls Gemini to generate the workflow plan
 */
export async function startSession(request: StartSessionRequest): Promise<StartSessionResponse> {
  const response = await fetch(`${API_BASE_URL}/api/session/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Unknown error' }));
    throw new ApiError(response.status, error.detail || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Get the next action for the current session
 */
export async function getNextAction(request: NextActionRequest): Promise<NextActionResponse> {
  const response = await fetch(`${API_BASE_URL}/api/session/next`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Unknown error' }));
    throw new ApiError(response.status, error.detail || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Send correction when user says the suggested element was wrong
 */
export async function sendCorrection(
  sessionId: string,
  feedback: 'wrong_element' | 'doesnt_work',
  actualFeatureIndex?: number
): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/session/correct`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      session_id: sessionId,
      feedback,
      actual_feature_index: actualFeatureIndex,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Unknown error' }));
    throw new ApiError(response.status, error.detail || `HTTP ${response.status}`);
  }
}

/**
 * Check if the backend is available
 */
export async function healthCheck(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE_URL}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

// ============================================
// Context Graph / Procedures API
// ============================================

export interface ProcedureStep {
  id: string;
  index: number;
  instruction: string;
  action_type: 'click' | 'type' | 'navigate' | 'wait';
  selector_hint?: string | null;
  expected_state?: string | null;
}

export interface Procedure {
  id: string;
  goal: string;
  source_text?: string;
  steps: ProcedureStep[];
}

// Known company IDs for different platforms
export const KNOWN_COMPANIES: Record<string, string> = {
  'amplitude.com': 'cc410d4f-b927-4d6e-a972-b78c4ba50a0c',
  'analytics.amplitude.com': 'cc410d4f-b927-4d6e-a972-b78c4ba50a0c',
};

/**
 * Get company ID based on current URL
 */
export function getCompanyIdFromUrl(url: string): string | null {
  try {
    const hostname = new URL(url).hostname;
    for (const [domain, companyId] of Object.entries(KNOWN_COMPANIES)) {
      if (hostname.includes(domain)) {
        return companyId;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get all procedures for a company
 */
export async function getProcedures(companyId: string): Promise<Procedure[]> {
  const response = await fetch(`${API_BASE_URL}/api/companies/${companyId}/procedures`);
  
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to get procedures`);
  }
  
  return response.json();
}

/**
 * Find the best matching procedure for a user goal
 */
export async function findMatchingProcedure(
  companyId: string,
  userGoal: string
): Promise<Procedure | null> {
  try {
    const procedures = await getProcedures(companyId);
    
    if (!procedures || procedures.length === 0) {
      return null;
    }
    
    // Simple keyword matching - find best match
    const goalLower = userGoal.toLowerCase();
    
    let bestMatch: Procedure | null = null;
    let bestScore = 0;
    
    for (const proc of procedures) {
      const procGoalLower = proc.goal.toLowerCase();
      
      // Count matching words
      const goalWords = goalLower.split(/\s+/);
      const matchingWords = goalWords.filter(word => 
        procGoalLower.includes(word) && word.length > 2
      );
      
      const score = matchingWords.length;
      
      if (score > bestScore) {
        bestScore = score;
        bestMatch = proc;
      }
    }
    
    // Require at least 1 matching word
    if (bestScore >= 1) {
      return bestMatch;
    }
    
    return null;
  } catch (error) {
    console.error('Error finding procedure:', error);
    return null;
  }
}

/**
 * Convert a procedure step to a PlannedStep format
 */
export function procedureStepToPlannedStep(
  step: ProcedureStep,
  stepNumber: number
): PlannedStep {
  const actionMap: Record<string, PlannedStep['action']> = {
    'click': 'CLICK',
    'type': 'TYPE',
    'navigate': 'CLICK',
    'wait': 'WAIT',
  };
  
  // Extract key terms from instruction for text matching
  const instruction = step.instruction;
  const quotedTerms: string[] = [];
  const quoteMatches = instruction.match(/'([^']+)'/g);
  if (quoteMatches) {
    quoteMatches.forEach(m => quotedTerms.push(m.replace(/'/g, '')));
  }
  
  // Also get important words (longer than 4 chars, not common words)
  const commonWords = ['click', 'select', 'enter', 'navigate', 'go to', 'from', 'the', 'your', 'this', 'that', 'with', 'for'];
  const keywords = instruction.toLowerCase().split(/\s+/)
    .filter(w => w.length > 4 && !commonWords.includes(w));
  
  const textContains = [...quotedTerms, ...keywords.slice(0, 5)];
  
  return {
    step_number: stepNumber,
    action: actionMap[step.action_type] || 'CLICK',
    description: step.instruction,
    target_hints: {
      text_contains: textContains,
      selector_pattern: step.selector_hint || undefined,
    },
    text_input: undefined,
    expected_page_change: step.action_type === 'navigate' || 
      instruction.toLowerCase().includes('submit') ||
      instruction.toLowerCase().includes('create') ||
      instruction.toLowerCase().includes('save'),
  };
}

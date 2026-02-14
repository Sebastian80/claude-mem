import { describe, it, expect } from 'bun:test';
import { VectorDocumentFormatter } from '../../src/services/vector/VectorDocumentFormatter.js';
import type { StoredObservation, StoredSummary, StoredUserPrompt } from '../../src/services/vector/VectorDocumentFormatter.js';

const baseObservation: StoredObservation = {
  id: 42,
  memory_session_id: 'sess-001',
  project: 'test-project',
  text: null,
  type: 'discovery',
  title: 'Found a bug',
  subtitle: 'In auth module',
  facts: JSON.stringify(['fact one', 'fact two']),
  narrative: 'Discovered a critical auth bug in the login flow',
  concepts: JSON.stringify(['authentication', 'security']),
  files_read: JSON.stringify(['src/auth.ts']),
  files_modified: JSON.stringify(['src/auth.ts', 'src/login.ts']),
  prompt_number: 3,
  discovery_tokens: 500,
  created_at: '2026-01-15T10:00:00.000Z',
  created_at_epoch: 1768467600000
};

const baseSummary: StoredSummary = {
  id: 10,
  memory_session_id: 'sess-002',
  project: 'test-project',
  request: 'Fix the auth bug',
  investigated: 'Login flow and token handling',
  learned: 'Token expiry was not checked',
  completed: 'Added token validation',
  next_steps: 'Add tests for edge cases',
  notes: 'Consider adding refresh token support',
  prompt_number: 5,
  discovery_tokens: 1200,
  created_at: '2026-01-15T12:00:00.000Z',
  created_at_epoch: 1768474800000
};

const basePrompt: StoredUserPrompt = {
  id: 7,
  content_session_id: 'content-sess-003',
  prompt_number: 1,
  prompt_text: 'How does the authentication module work?',
  created_at: '2026-01-15T09:00:00.000Z',
  created_at_epoch: 1768464000000,
  memory_session_id: 'sess-003',
  project: 'test-project'
};

describe('VectorDocumentFormatter', () => {
  describe('formatObservationDocs', () => {
    it('should create a narrative document', () => {
      const docs = VectorDocumentFormatter.formatObservationDocs(baseObservation);
      const narrativeDoc = docs.find(d => d.id === 'obs_42_narrative');

      expect(narrativeDoc).toBeDefined();
      expect(narrativeDoc!.document).toBe('Discovered a critical auth bug in the login flow');
      expect(narrativeDoc!.metadata.sqlite_id).toBe(42);
      expect(narrativeDoc!.metadata.doc_type).toBe('observation');
      expect(narrativeDoc!.metadata.field_type).toBe('narrative');
      expect(narrativeDoc!.metadata.project).toBe('test-project');
    });

    it('should create fact documents', () => {
      const docs = VectorDocumentFormatter.formatObservationDocs(baseObservation);
      const factDocs = docs.filter(d => d.id.includes('_fact_'));

      expect(factDocs).toHaveLength(2);
      expect(factDocs[0].id).toBe('obs_42_fact_0');
      expect(factDocs[0].document).toBe('fact one');
      expect(factDocs[0].metadata.field_type).toBe('fact');
      expect(factDocs[0].metadata.fact_index).toBe(0);
      expect(factDocs[1].id).toBe('obs_42_fact_1');
      expect(factDocs[1].document).toBe('fact two');
    });

    it('should include concepts and files in metadata', () => {
      const docs = VectorDocumentFormatter.formatObservationDocs(baseObservation);
      const narrativeDoc = docs.find(d => d.id === 'obs_42_narrative')!;

      expect(narrativeDoc.metadata.concepts).toBe('authentication,security');
      expect(narrativeDoc.metadata.files_read).toBe('src/auth.ts');
      expect(narrativeDoc.metadata.files_modified).toBe('src/auth.ts,src/login.ts');
    });

    it('should include text document when text field exists', () => {
      const obsWithText = { ...baseObservation, text: 'Some raw text' };
      const docs = VectorDocumentFormatter.formatObservationDocs(obsWithText);
      const textDoc = docs.find(d => d.id === 'obs_42_text');

      expect(textDoc).toBeDefined();
      expect(textDoc!.document).toBe('Some raw text');
      expect(textDoc!.metadata.field_type).toBe('text');
    });

    it('should handle observation with no narrative, no text, no facts', () => {
      const emptyObs: StoredObservation = {
        ...baseObservation,
        narrative: null,
        text: null,
        facts: null,
        concepts: null,
        files_read: null,
        files_modified: null,
        subtitle: null
      };
      const docs = VectorDocumentFormatter.formatObservationDocs(emptyObs);
      expect(docs).toHaveLength(0);
    });

    it('should handle empty JSON arrays in fields', () => {
      const obs = { ...baseObservation, facts: '[]', concepts: '[]', files_read: '[]', files_modified: '[]' };
      const docs = VectorDocumentFormatter.formatObservationDocs(obs);

      // Should only have narrative (no facts, no text)
      expect(docs).toHaveLength(1);
      expect(docs[0].id).toBe('obs_42_narrative');
      // Empty arrays should not appear in metadata
      expect(docs[0].metadata.concepts).toBeUndefined();
      expect(docs[0].metadata.files_read).toBeUndefined();
      expect(docs[0].metadata.files_modified).toBeUndefined();
    });

    it('should use defaults for missing type/title', () => {
      const obs = { ...baseObservation, type: '', title: null };
      const docs = VectorDocumentFormatter.formatObservationDocs(obs);
      const doc = docs[0];

      expect(doc.metadata.type).toBe('discovery');
      expect(doc.metadata.title).toBe('Untitled');
    });
  });

  describe('formatSummaryDocs', () => {
    it('should create documents for all summary fields', () => {
      const docs = VectorDocumentFormatter.formatSummaryDocs(baseSummary);

      expect(docs).toHaveLength(6); // request, investigated, learned, completed, next_steps, notes
      expect(docs.map(d => d.metadata.field_type)).toEqual([
        'request', 'investigated', 'learned', 'completed', 'next_steps', 'notes'
      ]);
    });

    it('should set correct IDs', () => {
      const docs = VectorDocumentFormatter.formatSummaryDocs(baseSummary);

      expect(docs[0].id).toBe('summary_10_request');
      expect(docs[1].id).toBe('summary_10_investigated');
    });

    it('should include correct metadata', () => {
      const docs = VectorDocumentFormatter.formatSummaryDocs(baseSummary);
      const doc = docs[0];

      expect(doc.metadata.sqlite_id).toBe(10);
      expect(doc.metadata.doc_type).toBe('session_summary');
      expect(doc.metadata.memory_session_id).toBe('sess-002');
      expect(doc.metadata.project).toBe('test-project');
      expect(doc.metadata.created_at_epoch).toBe(1768474800000);
    });

    it('should skip null fields', () => {
      const summary = { ...baseSummary, investigated: null, notes: null };
      const docs = VectorDocumentFormatter.formatSummaryDocs(summary);

      expect(docs).toHaveLength(4); // request, learned, completed, next_steps
      expect(docs.map(d => d.metadata.field_type)).toEqual([
        'request', 'learned', 'completed', 'next_steps'
      ]);
    });

    it('should handle summary with all null fields', () => {
      const emptySummary: StoredSummary = {
        ...baseSummary,
        request: null,
        investigated: null,
        learned: null,
        completed: null,
        next_steps: null,
        notes: null
      };
      const docs = VectorDocumentFormatter.formatSummaryDocs(emptySummary);
      expect(docs).toHaveLength(0);
    });
  });

  describe('formatUserPromptDoc', () => {
    it('should create a single document', () => {
      const doc = VectorDocumentFormatter.formatUserPromptDoc(basePrompt);

      expect(doc.id).toBe('prompt_7');
      expect(doc.document).toBe('How does the authentication module work?');
    });

    it('should include correct metadata', () => {
      const doc = VectorDocumentFormatter.formatUserPromptDoc(basePrompt);

      expect(doc.metadata.sqlite_id).toBe(7);
      expect(doc.metadata.doc_type).toBe('user_prompt');
      expect(doc.metadata.memory_session_id).toBe('sess-003');
      expect(doc.metadata.project).toBe('test-project');
      expect(doc.metadata.created_at_epoch).toBe(1768464000000);
      expect(doc.metadata.prompt_number).toBe(1);
    });
  });
});

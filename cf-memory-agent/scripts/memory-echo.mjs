// Memory retrieval/write echoes (including failures) repeat stored knowledge. Keep
// their Capture originals, but never treat them as independent new evidence.
// Match this integration's exact namespace and explicit tools, not arbitrary
// names containing "search"/"memory" or output text controlled by a tool.
const memoryTools = new Set([
  'recall', 'build_prompt', 'memory_lookup', 'notes_search', 'notes_get', 'notes_get_many', 'notes_list',
  'notes_backlinks', 'notes_links', 'notes_history', 'notes_retraction_status', 'notes_append_status', 'memory_export', 'memory_export_provenance',
  'skills_search', 'skills_get', 'skills_list', 'memory_get', 'memory_list',
  'timeline', 'capture_session_timeline', 'capture_sessions', 'capture_get_many', 'capture_search', 'provenance_search',
  'notes_put', 'notes_update_text', 'notes_append', 'notes_append_guarded', 'notes_delete', 'notes_archive', 'notes_unarchive', 'notes_rename',
  'skills_put', 'skills_delete', 'skills_fork', 'skills_file_read', 'skills_file_create',
  'memory_set', 'memory_append', 'memory_replace', 'memory_import_provenance', 'provenance_attach',
]);
export function isMemoryEcho(event) {
  if (!['PostToolUse', 'PostToolUseFailure'].includes(event?.event_type)) return false;
  if (event.payload_redacted?.evidence_kind === 'retrieved_memory') return true;
  const match = typeof event.tool_name === 'string' && event.tool_name.match(/^mcp__cf-memory__(\w+)$/);
  return Boolean(match && memoryTools.has(match[1]));
}

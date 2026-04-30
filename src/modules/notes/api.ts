import { invoke } from '@tauri-apps/api/core';

export type Note = {
  id: number;
  title: string;
  body: string;
  created_at: number;
  updated_at: number;
  /** Absolute path to the note's primary recorded audio, if any. */
  audio_path: string | null;
  /** Recording length in milliseconds, when known. */
  audio_duration_ms: number | null;
  /** User-pinned notes float to the top of the side-list. */
  pinned: boolean;
  /** Whisper transcript of the primary audio recording, if transcription has been run. */
  audio_transcription: string | null;
  /** Folder this note belongs to. `null` means unfiled. */
  folder_id: number | null;
};

/** Lightweight projection returned by the list / search endpoints — carries a
 *  short body preview instead of the full markdown so opening Notes stays cheap
 *  even when a user has hundreds of long entries. Fetch the full body via
 *  `notesGet(id)` only when a note is actually activated. */
export type NoteSummary = {
  id: number;
  title: string;
  preview: string;
  created_at: number;
  updated_at: number;
  pinned: boolean;
  folder_id: number | null;
};

/** A user-created note folder. Folders are flat (no nesting); their visual
 *  order is `sort_order` ASC, controllable via drag-reorder. */
export type NoteFolder = {
  id: number;
  name: string;
  sort_order: number;
  created_at: number;
};

/** Filter passed to `notesList` / `notesSearch`. `'all'` is no filter,
 *  `'unfiled'` matches notes without a folder, a numeric id targets that
 *  folder. Encoded as a string so the IPC stays JSON-friendly. */
export type FolderFilter = 'all' | 'unfiled' | number;

const encodeFolderFilter = (f: FolderFilter | undefined): string | undefined => {
  if (f === undefined || f === 'all') return undefined;
  return typeof f === 'number' ? String(f) : f;
};

export const notesList = (folder?: FolderFilter): Promise<NoteSummary[]> =>
  invoke('notes_list', { folder: encodeFolderFilter(folder) });
export const notesSetPinned = (id: number, pinned: boolean): Promise<void> =>
  invoke('notes_set_pinned', { id, pinned });
export const notesSearch = (query: string, folder?: FolderFilter): Promise<NoteSummary[]> =>
  invoke('notes_search', { query, folder: encodeFolderFilter(folder) });

export const notesFoldersList = (): Promise<NoteFolder[]> =>
  invoke('notes_folders_list');
export const notesFolderCreate = (name: string): Promise<number> =>
  invoke('notes_folder_create', { name });
export const notesFolderRename = (id: number, name: string): Promise<void> =>
  invoke('notes_folder_rename', { id, name });
export const notesFolderDelete = (id: number): Promise<void> =>
  invoke('notes_folder_delete', { id });
export const notesFoldersReorder = (ids: number[]): Promise<void> =>
  invoke('notes_folders_reorder', { ids });
/** Move (or unfile) a note. Pass `null` to remove its folder assignment. */
export const notesSetFolder = (
  noteId: number,
  folderId: number | null
): Promise<void> => invoke('notes_set_folder', { noteId, folderId });
export const notesGet = (id: number): Promise<Note | null> =>
  invoke('notes_get', { id });
export const notesCreate = (title: string, body: string): Promise<number> =>
  invoke('notes_create', { title, body });
export const notesUpdate = (
  id: number,
  title: string,
  body: string
): Promise<void> => invoke('notes_update', { id, title, body });
export const notesDelete = (id: number): Promise<void> =>
  invoke('notes_delete', { id });

export type ReadFileResult = { name: string; contents: string };

export const notesReadFile = (path: string): Promise<ReadFileResult> =>
  invoke('notes_read_file', { path });

export const notesWriteFile = (path: string, content: string): Promise<void> =>
  invoke('notes_write_file', { path, content });

/** Write the current note's body to a stable on-disk markdown file under
 *  the managed exports dir and return the absolute path. Used for
 *  Reveal-in-Finder and for piping a note to external tools like Claude
 *  Code. Re-exports on each call so the file content always matches the
 *  latest saved note. */
export const notesExportPath = (id: number): Promise<string> =>
  invoke('notes_export_path', { id });

/** Persist audio bytes (from the recorder) into the managed audio directory.
 *  Returns the absolute path so the caller can embed it into a note's body
 *  via markdown: `![voice note](/abs/path)`. */
export const notesSaveAudioBytes = (bytes: Uint8Array, ext: string): Promise<string> =>
  invoke('notes_save_audio_bytes', { bytes: Array.from(bytes), ext });

/** Copy an audio file at `path` (e.g. dropped from Finder) into the managed
 *  audio directory. Returns the new absolute path for markdown-embed use. */
export const notesSaveAudioFile = (path: string): Promise<string> =>
  invoke('notes_save_audio_file', { path });

/** Read raw audio bytes by absolute path. Only paths under the managed audio
 *  dir are accepted (the Rust side enforces this). Used by the inline
 *  markdown audio player, which references files by path from `![](…)`. */
export const notesReadAudioByPath = (path: string): Promise<Uint8Array> =>
  invoke<number[]>('notes_read_audio_path', { path }).then((arr) => new Uint8Array(arr));

/** Resolve a `http://127.0.0.1:<port>/audio?…` URL for a managed audio file.
 *  Used when WKWebView's `<audio>` would otherwise hand the source off to
 *  AVFoundation, which can't open Tauri's `asset://` protocol. The URL is
 *  served by an in-process loopback server (per-app token, scope-checked
 *  paths) and supports HTTP Range, so seeking works for huge attachments
 *  without any IPC byte transfer. */
export const notesAudioStreamUrl = (path: string): Promise<string> =>
  invoke<string>('notes_audio_stream_url', { path });

/** Persist image bytes (e.g. a screenshot pasted from the clipboard) into
 *  the managed images dir. Returns the absolute path for embedding via
 *  markdown's `![alt](path)` syntax. */
export const notesSaveImageBytes = (bytes: Uint8Array, ext: string): Promise<string> =>
  invoke('notes_save_image_bytes', { bytes: Array.from(bytes), ext });

/** Copy an on-disk image file into the managed images dir. Source is left
 *  untouched so Finder's original stays where it is. */
export const notesSaveImageFile = (path: string): Promise<string> =>
  invoke('notes_save_image_file', { path });

/** Read raw image bytes by absolute path. Only paths under the managed
 *  images dir are accepted. Prefer `notesImageStreamUrl` for the inline
 *  embed — round-tripping bytes through IPC turns into hundreds of MB of
 *  JSON for large captures. */
export const notesReadImageByPath = (path: string): Promise<Uint8Array> =>
  invoke<number[]>('notes_read_image_path', { path }).then((arr) => new Uint8Array(arr));

/** Resolve a `http://127.0.0.1:<port>/image?…` URL for a managed image
 *  file. Served by the same loopback media server as audio (per-app
 *  token, scope-checked paths). The browser fetches bytes directly over
 *  HTTP — zero IPC payload — so even multi-MB screenshots embed without
 *  blocking the main thread on JSON.parse. */
export const notesImageStreamUrl = (path: string): Promise<string> =>
  invoke<string>('notes_image_stream_url', { path });

export type NoteAttachment = {
  id: number;
  note_id: number;
  file_path: string;
  original_name: string;
  mime_type: string | null;
  size_bytes: number | null;
  created_at: number;
  /** Whisper transcript of the attachment audio, if transcription has been run. */
  transcription: string | null;
};

export const notesListAttachments = (noteId: number): Promise<NoteAttachment[]> =>
  invoke('notes_list_attachments', { noteId });

/** Copy `sourcePath` into the note's private attachments directory and
 *  record a row. The original file on disk is *not* moved — removing the
 *  attachment later only unlinks the copy. */
export const notesAddAttachment = (
  noteId: number,
  sourcePath: string,
): Promise<NoteAttachment> =>
  invoke('notes_add_attachment', { noteId, sourcePath });

export const notesRemoveAttachment = (id: number): Promise<void> =>
  invoke('notes_remove_attachment', { id });

/** Manually set (or clear) the transcription for a note's primary audio
 *  recording. Pass `null` to erase a previously stored transcription. */
export const notesSetAudioTranscription = (
  noteId: number,
  transcription: string | null,
): Promise<void> =>
  invoke('notes_set_audio_transcription', { noteId, transcription });

/** Manually set (or clear) the transcription for an audio attachment.
 *  Pass `null` to erase a previously stored transcription. */
export const notesSetAttachmentTranscription = (
  id: number,
  transcription: string | null,
): Promise<void> =>
  invoke('notes_set_attachment_transcription', { id, transcription });

/** Start a Whisper transcription of the note's primary audio recording.
 *  Returns immediately. Listen for Tauri events:
 *  - `notes:audio_transcribing`        `{ note_id }`
 *  - `notes:note_updated`              `{ note_id }`
 *  - `notes:audio_transcribe_failed`   `{ note_id, error }` */
export const notesTranscribeNoteAudio = (noteId: number): Promise<void> =>
  invoke('notes_transcribe_note_audio', { noteId });

/** Start a Whisper transcription of an audio attachment.
 *  Returns immediately. Listen for Tauri events:
 *  - `notes:attachment_transcribing`       `{ id }`
 *  - `notes:attachment_updated`            `{ id }`
 *  - `notes:attachment_transcribe_failed`  `{ id, error }` */
export const notesTranscribeAttachment = (attachmentId: number): Promise<void> =>
  invoke('notes_transcribe_attachment', { attachmentId });

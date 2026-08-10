import Editor from '@monaco-editor/react';
import { editor, Range, Selection } from 'monaco-editor';
import React, { useRef, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import Loading from 'react-loading';
import { FlatInset, FlatTabButton } from "@rin/ui";
import { useAlert } from "./dialog";
import { useColorMode } from "../utils/darkModeUtils";
import { buildMarkdownImage, isImageFile, uploadImageFile, DEFAULT_VIDEO_MAX_FILE_SIZE, isVideoFile, buildMarkdownVideo, uploadVideoToNetpan, isAudioFile, uploadFileToNetpan, buildMarkdownAudio, buildMarkdownFile, attachVideoPoster } from "../utils/image-upload";
import { NETPAN_MAX_FILE_SIZE } from "../netpan";
import { Markdown } from "./markdown";
import { mapWithConcurrency } from "../utils/concurrency";
import { addUpload, setUploadStatus, setUploadProgress, setUploadSize, setUploadUrl, registerRetry, registerAbort } from "../utils/upload-progress-store";
import { isAbortError } from "../utils/upload-with-progress";
import { acquireWakeLock, releaseWakeLock } from "../utils/wake-lock";

// 与上传悬浮窗并发显示上限一致（见 utils/concurrency.ts）。
const CONCURRENCY_LIMIT = 10;


interface MarkdownEditorProps {
  content: string;
  setContent: (content: string) => void;
  placeholder?: string;
  height?: string;
}

type EditorPosition = {
  lineNumber: number;
  column: number;
};

function positionAfterText(startLineNumber: number, startColumn: number, text: string): EditorPosition {
  const lines = text.split("\n");

  if (lines.length === 1) {
    return {
      lineNumber: startLineNumber,
      column: startColumn + text.length,
    };
  }

  return {
    lineNumber: startLineNumber + lines.length - 1,
    column: lines[lines.length - 1].length + 1,
  };
}

function MarkdownToolButton({
  label,
  icon,
  onClick,
  disabled = false,
  active = false,
}: {
  label: string;
  icon: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={
        "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border text-lg t-secondary transition-colors hover:border-black/10 hover:bg-neutral-100 hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-theme disabled:cursor-not-allowed disabled:opacity-50 dark:hover:border-white/10 dark:hover:bg-neutral-700 dark:hover:text-white sm:h-10 sm:w-10" +
        (active ? " border-theme bg-theme/10 text-theme" : " border-transparent")
      }
    >
      <i className={icon} aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </button>
  );
}

export function MarkdownEditor({ content, setContent, placeholder = "> Write your content here...", height = "400px" }: MarkdownEditorProps) {
  const { t } = useTranslation();
  const colorMode = useColorMode();
  const editorRef = useRef<editor.IStandaloneCodeEditor>();
  const isComposingRef = useRef(false);
  const [preview, setPreview] = useState<'edit' | 'preview' | 'comparison'>('edit');
  const [uploading, setUploading] = useState(false);
  const { showAlert, AlertUI } = useAlert();

  async function insertImage(
    file: File,
    range: NonNullable<ReturnType<editor.IStandaloneCodeEditor["getSelection"]>>,
    showAlert: (msg: string) => void,
  ): Promise<EditorPosition | undefined> {
    const id = addUpload(file.name, file.size);

    // 重传闭包：失败后在悬浮窗点「重新上传」时回调，重传到原位置。
    const retryInsert = async () => {
      setUploadStatus(id, "uploading");
      const controller = new AbortController();
      registerAbort(id, () => controller.abort());
      try {
        const result = await uploadImageFile(file, (pct) => setUploadProgress(id, pct), controller.signal, (size) => setUploadSize(id, size));
        const editorInstance = editorRef.current;
        if (!editorInstance) return;
        const imageText = buildMarkdownImage(file.name, result.url, {
          blurhash: result.blurhash,
          width: result.width,
          height: result.height,
        });
        editorInstance.executeEdits(undefined, [{
          range,
          text: imageText,
        }]);
        editorInstance.focus();
        setUploadUrl(id, result.url);
        setUploadStatus(id, "done");
      } catch (error) {
        if (isAbortError(error)) {
          setUploadStatus(id, "cancelled");
          return;
        }
        console.error(error);
        const msg = error instanceof Error ? error.message : t("upload.failed");
        setUploadStatus(id, "error", msg);
        showAlert(msg);
      }
    };
    registerRetry(id, retryInsert);

    await acquireWakeLock();
    try {
      await retryInsert();
    } finally {
      releaseWakeLock();
    }
    return undefined;
  }

  // Insert a raw snippet (markdown/HTML) at the given range and return the
  // cursor position right after it, so callers can chain multiple inserts.
  const insertSnippetAtCursor = (
    text: string,
    range: NonNullable<ReturnType<editor.IStandaloneCodeEditor["getSelection"]>>,
  ): EditorPosition | undefined => {
    const editorInstance = editorRef.current;
    if (!editorInstance) return undefined;
    editorInstance.executeEdits(undefined, [{ range, text }]);
    editorInstance.focus();
    return positionAfterText(range.startLineNumber, range.startColumn, text);
  };

  // Upload and insert multiple media files with bounded concurrency. `validate`
  // returns an error message (or null) per file; `produce(file, onProgress)`
  // returns the markdown/HTML snippet for an already-uploaded file while
  // reporting upload progress (0..100). Each file is registered in the global
  // upload-progress store so the floating window can show per-file progress;
  // up to CONCURRENCY_LIMIT files upload at once, the rest are queued.
  const insertMediaSequentially = async (
    files: FileList | File[],
    validate: (file: File) => string | null | Promise<string | null>,
    produce: (file: File, onProgress: (pct: number) => void, signal: AbortSignal, onCompressedSize?: (size: number) => void) => Promise<{ snippet: string; url: string }>,
    showAlert: (msg: string) => void,
  ) => {
    const editorInstance = editorRef.current;
    if (!editorInstance) return;

    let cursor = editorInstance.getSelection();
    if (!cursor) return;

    const fileList = Array.from(files);
    if (fileList.length === 0) return;

    // 先把所有文件登记为排队中，悬浮窗立即可见。
    const ids = fileList.map((f) => addUpload(f.name, f.size));

    // 上传单个文件并上报进度，返回生成的 markdown 片段（失败返回 null）。
    // 抽出来供「首次并发上传」和「失败重试」复用。
    const uploadOne = async (
      file: File,
      i: number,
    ): Promise<string | null> => {
      const id = ids[i];
      const error = await validate(file);
      if (error) {
        setUploadStatus(id, "error", error);
        showAlert(error);
        return null;
      }
      const controller = new AbortController();
      registerAbort(id, () => controller.abort());
      try {
        setUploadStatus(id, "uploading");
        const { snippet, url } = await produce(file, (pct) => setUploadProgress(id, pct), controller.signal, (size) => setUploadSize(id, size));
        if (url) setUploadUrl(id, url);
        setUploadStatus(id, "done");
        return snippet;
      } catch (e) {
        if (isAbortError(e)) {
          setUploadStatus(id, "cancelled");
          return null;
        }
        const msg = e instanceof Error ? e.message : t("upload.failed");
        setUploadStatus(id, "error", msg);
        showAlert(msg);
        return null;
      }
    };

    // 把片段插入到编辑器当前光标处（重试时使用，首传时的光标已失效）。
    const insertAtCursor = (snippet: string) => {
      const ed = editorRef.current;
      if (!ed) return;
      const cur = ed.getSelection() ?? new Selection(1, 1, 1, 1);
      const next = insertSnippetAtCursor(snippet, cur);
      if (next) {
        ed.setSelection(new Selection(next.lineNumber, next.column, next.lineNumber, next.column));
      }
      ed.focus();
    };

    // 为每个文件注册重传闭包：失败后在悬浮窗点「重新上传」时回调，
    // 重新上传并插入到当前光标。
    fileList.forEach((file, i) => {
      registerRetry(ids[i], async () => {
        const snippet = await uploadOne(file, i);
        if (snippet) insertAtCursor(snippet);
      });
    });

    setUploading(true);
    await acquireWakeLock();
    try {
      const snippets = await mapWithConcurrency(
        fileList,
        CONCURRENCY_LIMIT,
        (file, i) => uploadOne(file, i),
      );

      // 按原始顺序插入成功生成的片段（失败项为 null，跳过）。
      for (const snippet of snippets) {
        if (!snippet) continue;
        const next = insertSnippetAtCursor(snippet, cursor);
        if (next) {
          cursor = new Selection(next.lineNumber, next.column, next.lineNumber, next.column);
        }
      }
      editorInstance.focus();
    } finally {
      setUploading(false);
      releaseWakeLock();
    }
  };

  const getEditorAndSelection = () => {
    const editorInstance = editorRef.current;
    const model = editorInstance?.getModel();
    const selection = editorInstance?.getSelection();

    if (!editorInstance || !model || !selection) {
      return null;
    }

    return { editorInstance, model, selection };
  };

  const replaceSelection = (selection: Selection, text: string, nextSelection?: Selection) => {
    const editorInstance = editorRef.current;
    if (!editorInstance) return;

    editorInstance.executeEdits("markdown-toolbar", [{
      range: selection,
      text,
      forceMoveMarkers: true,
    }]);
    setContent(editorInstance.getValue());

    if (nextSelection) {
      editorInstance.setSelection(nextSelection);
    } else {
      const position = positionAfterText(selection.startLineNumber, selection.startColumn, text);
      editorInstance.setPosition(position);
    }

    editorInstance.focus();
  };

  const wrapSelection = (prefix: string, suffix: string, fallback: string) => {
    const editorState = getEditorAndSelection();
    if (!editorState) return;

    const { model, selection } = editorState;
    const selectedText = model.getValueInRange(selection);
    const innerText = selectedText || fallback;
    const insertedText = `${prefix}${innerText}${suffix}`;
    const innerStart = positionAfterText(selection.startLineNumber, selection.startColumn, prefix);
    const innerEnd = positionAfterText(innerStart.lineNumber, innerStart.column, innerText);
    const end = positionAfterText(selection.startLineNumber, selection.startColumn, insertedText);
    const nextSelection = selectedText
      ? new Selection(end.lineNumber, end.column, end.lineNumber, end.column)
      : new Selection(innerStart.lineNumber, innerStart.column, innerEnd.lineNumber, innerEnd.column);

    replaceSelection(selection, insertedText, nextSelection);
  };

  const insertLink = () => {
    const editorState = getEditorAndSelection();
    if (!editorState) return;

    const { model, selection } = editorState;
    const selectedText = model.getValueInRange(selection);
    const label = selectedText || t("markdown_editor.placeholder.link_text");
    const url = t("markdown_editor.placeholder.link_url");
    const prefix = `[${label}](`;
    const insertedText = `${prefix}${url})`;
    const urlStart = positionAfterText(selection.startLineNumber, selection.startColumn, prefix);
    const urlEnd = positionAfterText(urlStart.lineNumber, urlStart.column, url);

    replaceSelection(selection, insertedText, new Selection(urlStart.lineNumber, urlStart.column, urlEnd.lineNumber, urlEnd.column));
  };

  const insertMarkdownImage = () => {
    const editorState = getEditorAndSelection();
    if (!editorState) return;

    const { model, selection } = editorState;
    const selectedText = model.getValueInRange(selection);
    const alt = selectedText || t("markdown_editor.placeholder.image_alt");
    const url = t("markdown_editor.placeholder.image_url");
    const prefix = `![${alt}](`;
    const insertedText = `${prefix}${url})`;
    const urlStart = positionAfterText(selection.startLineNumber, selection.startColumn, prefix);
    const urlEnd = positionAfterText(urlStart.lineNumber, urlStart.column, url);

    replaceSelection(selection, insertedText, new Selection(urlStart.lineNumber, urlStart.column, urlEnd.lineNumber, urlEnd.column));
  };

  const insertCodeBlock = () => {
    const editorState = getEditorAndSelection();
    if (!editorState) return;

    const { model, selection } = editorState;
    const selectedText = model.getValueInRange(selection);
    const innerText = selectedText || t("markdown_editor.placeholder.code_block");
    const prefix = "```\n";
    const insertedText = `${prefix}${innerText}\n\`\`\``;
    const innerStart = positionAfterText(selection.startLineNumber, selection.startColumn, prefix);
    const innerEnd = positionAfterText(innerStart.lineNumber, innerStart.column, innerText);
    const end = positionAfterText(selection.startLineNumber, selection.startColumn, insertedText);
    const nextSelection = selectedText
      ? new Selection(end.lineNumber, end.column, end.lineNumber, end.column)
      : new Selection(innerStart.lineNumber, innerStart.column, innerEnd.lineNumber, innerEnd.column);

    replaceSelection(selection, insertedText, nextSelection);
  };

  const insertHorizontalRule = () => {
    const editorState = getEditorAndSelection();
    if (!editorState) return;

    replaceSelection(editorState.selection, "\n---\n");
  };

  const formatSelectedLines = (
    formatter: (line: string, index: number) => string,
    emptyLineFallback: string,
  ) => {
    const editorState = getEditorAndSelection();
    if (!editorState) return;

    const { editorInstance, model, selection } = editorState;
    const startLineNumber = selection.startLineNumber;
    const endLineNumber = selection.endLineNumber > selection.startLineNumber && selection.endColumn === 1
      ? selection.endLineNumber - 1
      : selection.endLineNumber;
    const currentLine = model.getLineContent(startLineNumber);
    const isEmptySingleLine = selection.isEmpty() && currentLine.trim().length === 0;
    const lines = isEmptySingleLine
      ? [emptyLineFallback]
      : Array.from({ length: endLineNumber - startLineNumber + 1 }, (_, index) => {
        const lineNumber = startLineNumber + index;
        return formatter(model.getLineContent(lineNumber), index);
      });
    const targetEndLine = isEmptySingleLine ? startLineNumber : endLineNumber;
    const range = new Range(
      startLineNumber,
      1,
      targetEndLine,
      model.getLineMaxColumn(targetEndLine),
    );
    const insertedText = lines.join("\n");
    const end = positionAfterText(startLineNumber, 1, insertedText);

    editorInstance.executeEdits("markdown-toolbar", [{
      range,
      text: insertedText,
      forceMoveMarkers: true,
    }]);
    setContent(editorInstance.getValue());
    editorInstance.setPosition(end);
    editorInstance.focus();
  };

  const formatHeading = () => {
    formatSelectedLines(
      (line) => line.startsWith("#") ? `## ${line.replace(/^#+\s*/, "")}` : `## ${line}`,
      `## ${t("markdown_editor.placeholder.heading")}`,
    );
  };

  const formatQuote = () => {
    formatSelectedLines(
      (line) => line.startsWith("> ") ? line : `> ${line}`,
      `> ${t("markdown_editor.placeholder.quote")}`,
    );
  };

  const formatUnorderedList = () => {
    formatSelectedLines(
      (line) => line.match(/^\s*[-*]\s/) ? line : `- ${line}`,
      `- ${t("markdown_editor.placeholder.list_item")}`,
    );
  };

  const formatOrderedList = () => {
    formatSelectedLines(
      (line, index) => line.match(/^\s*\d+\.\s/) ? line : `${index + 1}. ${line}`,
      `1. ${t("markdown_editor.placeholder.list_item")}`,
    );
  };

  const markdownActions = [
    { key: "heading", icon: "ri-heading", label: t("markdown_editor.toolbar.heading"), onClick: formatHeading },
    { key: "bold", icon: "ri-bold", label: t("markdown_editor.toolbar.bold"), onClick: () => wrapSelection("**", "**", t("markdown_editor.placeholder.bold")) },
    { key: "italic", icon: "ri-italic", label: t("markdown_editor.toolbar.italic"), onClick: () => wrapSelection("*", "*", t("markdown_editor.placeholder.italic")) },
    { key: "link", icon: "ri-link", label: t("markdown_editor.toolbar.link"), onClick: insertLink },
    { key: "image", icon: "ri-image-line", label: t("markdown_editor.toolbar.image"), onClick: insertMarkdownImage },
    { key: "quote", icon: "ri-double-quotes-l", label: t("markdown_editor.toolbar.quote"), onClick: formatQuote },
    { key: "unordered-list", icon: "ri-list-unordered", label: t("markdown_editor.toolbar.unordered_list"), onClick: formatUnorderedList },
    { key: "ordered-list", icon: "ri-list-ordered", label: t("markdown_editor.toolbar.ordered_list"), onClick: formatOrderedList },
    { key: "inline-code", icon: "ri-code-s-slash-line", label: t("markdown_editor.toolbar.inline_code"), onClick: () => wrapSelection("`", "`", t("markdown_editor.placeholder.code")) },
    { key: "code-block", icon: "ri-code-box-line", label: t("markdown_editor.toolbar.code_block"), onClick: insertCodeBlock },
    { key: "horizontal-rule", icon: "ri-separator", label: t("markdown_editor.toolbar.horizontal_rule"), onClick: insertHorizontalRule },
  ];

  const handlePaste = async (event: React.ClipboardEvent<HTMLDivElement>) => {
    const clipboardData = event.clipboardData;
    if (clipboardData.files.length === 1) {
      const editor = editorRef.current;
      if (!editor) return;
      editor.trigger(undefined, "undo", undefined);
      setUploading(true);
      const myfile = clipboardData.files[0] as File;
      const selection = editor.getSelection();
      if (!selection) {
        setUploading(false);
        return;
      }
      void insertImage(myfile, selection, showAlert).finally(() => {
        setUploading(false);
      });
    }
  };

  function UploadImageButton() {
    const uploadRef = useRef<HTMLInputElement>(null);
    const label = t("markdown_editor.toolbar.upload_image");

    const upChange = (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = "";
      if (files.length === 0) return;
      void insertMediaSequentially(
        files,
        async (file) => {
          // The first button is backed by Cloudflare R2: images get the
          // blurhash/metadata optimization path, videos upload raw (no
          // transcode) — both land in the same R2 bucket.
          // 图片：客户端会压缩到 800KB 以下，不再限制原图大小。
          if (isImageFile(file)) return null;
          if (isVideoFile(file)) {
            if (file.size > DEFAULT_VIDEO_MAX_FILE_SIZE) return t("upload.failed$size", { size: Math.round(DEFAULT_VIDEO_MAX_FILE_SIZE / 1024 / 1024) });
            return null;
          }
          return t("upload.unsupported_type");
        },
        async (file, onProgress, signal, onCompressedSize) => {
          // uploadImageFile skips metadata generation for non-images, so it
          // safely uploads videos raw to R2 with no extra processing.
          const result = await uploadImageFile(file, onProgress, signal, onCompressedSize);
          if (isImageFile(file)) {
            return {
              snippet: buildMarkdownImage(file.name, result.url, {
                blurhash: result.blurhash,
                width: result.width,
                height: result.height,
              }),
              url: result.url,
            };
          }
          // For videos, try to generate a poster frame so mobile Safari
          // shows a thumbnail before play (it ignores the #t= media
          // fragment). Poster upload is best-effort; failures silently fall
          // back to no poster.
          const posterUrl = await attachVideoPoster(result.url);
          return {
            snippet: buildMarkdownVideo(file.name, result.url, posterUrl ?? undefined),
            url: result.url,
          };
        },
        showAlert,
      );
    };

    return (
      <>
        <input
          ref={uploadRef}
          onChange={upChange}
          className="hidden"
          type="file"
          accept="image/*,video/*"
          multiple
        />
        <MarkdownToolButton
          label={label}
          icon="ri-image-add-line"
          disabled={uploading}
          onClick={() => uploadRef.current?.click()}
        />
      </>
    );
  }

  function UploadVideoButton() {
    const uploadRef = useRef<HTMLInputElement>(null);
    const label = t("markdown_editor.toolbar.upload_video");

    const upChange = (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = "";
      if (files.length === 0) return;
      void insertMediaSequentially(
        files,
        (file) => {
          if (!isVideoFile(file) && !isImageFile(file)) return t("upload.unsupported_type");
          // 图片：会压缩到 800KB 以下，不再限制原图大小；视频保留图床上限。
          if (isVideoFile(file) && file.size > NETPAN_MAX_FILE_SIZE) return t("upload.failed$size", { size: Math.round(NETPAN_MAX_FILE_SIZE / 1024 / 1024) });
          return null;
        },
        async (file, onProgress, signal) => {
          // Both images and videos selected here upload to netpan (not R2),
          // so the button acts as a unified netpan media uploader.
          const url = await uploadFileToNetpan(file, onProgress, signal);
          if (isImageFile(file)) {
            return { snippet: buildMarkdownImage(file.name, url), url };
          }
          // Videos: generate a poster frame so the unplayed preview shows
          // on mobile Safari (which ignores the #t= media fragment trick).
          // attachVideoPoster uploads the poster to R2; failures are silent.
          const posterUrl = await attachVideoPoster(url);
          return {
            snippet: buildMarkdownVideo(file.name, url, posterUrl ?? undefined),
            url,
          };
        },
        showAlert,
      );
    };

    return (
      <>
        <input
          ref={uploadRef}
          onChange={upChange}
          className="hidden"
          type="file"
          accept="video/*,image/*"
          multiple
        />
        <MarkdownToolButton
          label={label}
          icon="ri-movie-line"
          disabled={uploading}
          onClick={() => uploadRef.current?.click()}
        />
      </>
    );
  }

  function UploadMusicButton() {
    const uploadRef = useRef<HTMLInputElement>(null);
    const [autoplay, setAutoplay] = useState(false);
    const label = t("markdown_editor.toolbar.upload_music");

    const upChange = (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = "";
      if (files.length === 0) return;
      void insertMediaSequentially(
        files,
        (file) => {
          if (!isAudioFile(file)) return t("upload.music.invalid_type");
          if (file.size > NETPAN_MAX_FILE_SIZE) return t("upload.failed$size", { size: Math.round(NETPAN_MAX_FILE_SIZE / 1024 / 1024) });
          return null;
        },
        async (file, onProgress, signal) => {
          const url = await uploadFileToNetpan(file, onProgress, signal);
          return { snippet: buildMarkdownAudio(file.name, url, autoplay), url };
        },
        showAlert,
      );
    };

    return (
      <>
        <input
          ref={uploadRef}
          onChange={upChange}
          className="hidden"
          type="file"
          accept=".mp3,.wav,.ogg,.m4a,.aac,.flac,.wma,.webm,.opus,.mid,.midi,.amr,.caf,.aiff,.ape"
          multiple
        />
        <MarkdownToolButton
          label={label}
          icon="ri-music-2-line"
          disabled={uploading}
          onClick={() => uploadRef.current?.click()}
        />
        <label
          className="flex shrink-0 cursor-pointer select-none items-center gap-1 text-xs text-neutral-500 hover:text-black dark:hover:text-white"
          title={t("markdown_editor.autoplay.hint")}
        >
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-theme"
            checked={autoplay}
            onChange={(event) => setAutoplay(event.target.checked)}
          />
          {t("markdown_editor.autoplay.label")}
        </label>
      </>
    );
  }

  function UploadFileButton() {
    const uploadRef = useRef<HTMLInputElement>(null);
    const label = t("markdown_editor.toolbar.upload_file");

    const upChange = (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = "";
      if (files.length === 0) return;
      void insertMediaSequentially(
        files,
        (file) => {
          if (file.size > NETPAN_MAX_FILE_SIZE) return t("upload.failed$size", { size: Math.round(NETPAN_MAX_FILE_SIZE / 1024 / 1024) });
          return null;
        },
        async (file, onProgress, signal) => {
          const url = await uploadFileToNetpan(file, onProgress, signal);
          return { snippet: buildMarkdownFile(file.name, url), url };
        },
        showAlert,
      );
    };

    return (
      <>
        <input
          ref={uploadRef}
          onChange={upChange}
          className="hidden"
          type="file"
          multiple
        />
        <MarkdownToolButton
          label={label}
          icon="ri-file-3-line"
          disabled={uploading}
          onClick={() => uploadRef.current?.click()}
        />
      </>
    );
  }

  /* ---------------- Monaco Mount & IME Optimization ---------------- */

  const handleEditorMount = (editor: editor.IStandaloneCodeEditor) => {
    editorRef.current = editor;

    editor.onDidCompositionStart(() => {
      isComposingRef.current = true;
    });

    editor.onDidCompositionEnd(() => {
      isComposingRef.current = false;
      setContent(editor.getValue());
    });

    editor.onDidChangeModelContent(() => {
      if (!isComposingRef.current) {
        setContent(editor.getValue());
      }
    });

    editor.onDidBlurEditorText(() => {
      setContent(editor.getValue());
    });
  };

  /* ---------------- synchronization ---------------- */

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const model = editor.getModel();
    if (!model) return;

    const editorValue = model.getValue();

    // Avoid infinite loops & prevent overwriting content being edited
    if (editorValue !== content) {
      editor.setValue(content);
    }
  }, [content]);

  /* ---------------- UI ---------------- */

  return (
    <div className="flex flex-col gap-0 sm:gap-3">
      <FlatInset className="flex flex-wrap items-center gap-2 border-0 border-b border-black/10 rounded-none bg-transparent p-2 dark:border-white/10 sm:p-3">
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          <FlatTabButton active={preview === 'edit'} onClick={() => setPreview('edit')}> {t("edit")} </FlatTabButton>
          <FlatTabButton active={preview === 'preview'} onClick={() => setPreview('preview')}> {t("preview")} </FlatTabButton>
          <FlatTabButton active={preview === 'comparison'} onClick={() => setPreview('comparison')}> {t("comparison")} </FlatTabButton>
        </div>
        <div className="flex-grow" />
        <div
          className="flex min-w-0 flex-wrap items-center gap-1"
          role="toolbar"
          aria-label={t("markdown_editor.toolbar.label")}
        >
          {markdownActions.map((action) => (
            <MarkdownToolButton
              key={action.key}
              label={action.label}
              icon={action.icon}
              onClick={action.onClick}
            />
          ))}
          <span className="mx-1 h-6 w-px bg-black/10 dark:bg-white/10" aria-hidden="true" />
          <span
            className="select-none text-[10px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500"
            title={t("markdown_editor.upload_target.cloudflare")}
          >
            {t("markdown_editor.upload_target.cloudflare")}
          </span>
          <UploadImageButton />
          <span className="mx-1 h-6 w-px bg-black/10 dark:bg-white/10" aria-hidden="true" />
          <span
            className="select-none text-[10px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500"
            title={t("markdown_editor.upload_target.netpan")}
          >
            {t("markdown_editor.upload_target.netpan")}
          </span>
          <UploadVideoButton />
          <UploadMusicButton />
          <UploadFileButton />
        </div>
        {uploading &&
          <div className="flex flex-row items-center space-x-2 px-2">
            <Loading type="spin" color="#FC466B" height={16} width={16} />
            <span className="text-sm text-neutral-500">{t('uploading')}</span>
          </div>
        }
      </FlatInset>
      <div className={`grid grid-cols-1 gap-0 sm:gap-4 ${preview === 'comparison' ? "lg:grid-cols-2" : ""}`}>
        <div className={"flex min-w-0 flex-col " + (preview === 'preview' ? "hidden" : "")}>
          <div
            className={"relative min-h-0 overflow-hidden rounded-none border-0 bg-w"}
            onDrop={(e) => {
              e.preventDefault();
              const files = e.dataTransfer.files;
              if (!files || files.length === 0) return;
              void insertMediaSequentially(
                files,
                async (file) => {
                  // 图片：客户端会压缩到 800KB 以下，不再限制原图大小。
                  if (isImageFile(file)) return null;
                  if (isVideoFile(file)) {
                    if (file.size > NETPAN_MAX_FILE_SIZE) return t("upload.failed$size", { size: Math.round(NETPAN_MAX_FILE_SIZE / 1024 / 1024) });
                    return null;
                  }
                  return t("upload.unsupported_type");
                },
                async (file, onProgress, signal, onCompressedSize) => {
                  if (isImageFile(file)) {
                    const result = await uploadImageFile(file, onProgress, signal, onCompressedSize);
                    return {
                      snippet: buildMarkdownImage(file.name, result.url, {
                        blurhash: result.blurhash,
                        width: result.width,
                        height: result.height,
                      }),
                      url: result.url,
                    };
                  }
                  const url = await uploadVideoToNetpan(file, onProgress, signal);
                  return { snippet: buildMarkdownVideo(file.name, url), url };
                },
                showAlert,
              );
            }}
            onPaste={handlePaste}
          >
            <Editor
              onMount={handleEditorMount}
              height={height}
              defaultLanguage="markdown"
              defaultValue={content}
              theme={colorMode === "dark" ? "vs-dark" : "light"}
              options={{
                wordWrap: "on",

                // Chinese IME stability key
                fontFamily: "Sarasa Mono SC, JetBrains Mono, monospace",
                fontLigatures: false,
                letterSpacing: 0,

                fontSize: 14,
                lineNumbers: "off",

                accessibilitySupport: "off",
                unicodeHighlight: { ambiguousCharacters: false },

                renderWhitespace: "none",
                renderControlCharacters: false,
                smoothScrolling: false,

                dragAndDrop: true,
                pasteAs: { enabled: false },
              }}
            />
          </div>
        </div>
        <div
          className={"min-h-0 overflow-y-auto rounded-none border-0 bg-w px-4 py-4 border-t sm:border-none " + (preview === 'edit' ? "hidden" : "")}
          style={{ height: height }}
        >
          <Markdown content={content ? content : placeholder} />
        </div>
      </div>
      <AlertUI />
    </div>
  );
}

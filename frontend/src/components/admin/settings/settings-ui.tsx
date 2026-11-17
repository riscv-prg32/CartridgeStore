"use client";

import { CheckCircle2, CloudUpload, FileImage, Trash2, type LucideIcon } from "lucide-react";
import Image from "next/image";
import { useEffect, useId, useState, type DragEvent, type ReactNode } from "react";

import { Button } from "../../ui/button";
import { HelpTooltip } from "../../ui/help-tooltip";
import { Field } from "../admin-ui";
import {
  MANAGED_ASSET_UPDATED_EVENT,
  type ManagedAssetKind,
} from "../../../lib/runtime-assets";

export type SettingValues = Record<string, unknown>;

type PreparedAsset = {
  readonly file: File;
  readonly compressed: boolean;
};

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The image could not be read."));
    image.src = source;
  });
}

async function prepareAsset(file: File, kind: ManagedAssetKind): Promise<PreparedAsset> {
  const source = URL.createObjectURL(file);
  try {
    const image = await loadImage(source);
    const maxDimension = kind === "favicon" ? 512 : 1600;
    const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
    const webp = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", kind === "favicon" ? 0.92 : 0.84),
    );
    if (!webp || webp.size >= file.size) return { file, compressed: false };
    return {
      file: new File([webp], `${kind}.webp`, {
        type: "image/webp",
        lastModified: Date.now(),
      }),
      compressed: true,
    };
  } catch {
    return { file, compressed: false };
  } finally {
    URL.revokeObjectURL(source);
  }
}

export function AssetUpload({
  kind,
  currentUrl,
  onUpload,
  onDelete,
}: {
  kind: ManagedAssetKind;
  currentUrl: string;
  onUpload: (kind: ManagedAssetKind, file: File) => Promise<string>;
  onDelete: (kind: ManagedAssetKind) => Promise<void>;
}) {
  const inputId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const uploadTooltipId = useId();

  useEffect(() => {
    return () => {
      if (previewUrl.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  async function chooseFile(candidate: File | undefined) {
    if (!candidate) return;
    if (!candidate.type.startsWith("image/") && !/\.ico$/i.test(candidate.name)) {
      setError("Select a PNG, JPEG, WebP, or ICO image.");
      return;
    }
    setError("");
    setStatus("Preparing WebP…");
    setIsPreparing(true);
    const prepared = await prepareAsset(candidate, kind);
    setFile(prepared.file);
    setPreviewUrl(URL.createObjectURL(prepared.file));
    setStatus(
      prepared.compressed
        ? `WebP ready · ${formatBytes(prepared.file.size)}`
        : `Ready · ${formatBytes(prepared.file.size)}`,
    );
    setIsPreparing(false);
  }

  function handleDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setIsDragging(false);
    void chooseFile(event.dataTransfer.files[0]);
  }

  async function upload() {
    if (!file) return;
    setError("");
    setIsUploading(true);
    try {
      const assetUrl = await onUpload(kind, file);
      setStatus(`Uploaded · ${formatBytes(file.size)}`);
      setFile(null);
      setPreviewUrl(assetUrl);
    } catch {
      setError("Upload failed. Check the file and try again.");
    } finally {
      setIsUploading(false);
    }
  }

  async function remove() {
    if (!currentUrl || isDeleting) return;
    if (!window.confirm(`Remove the current ${kind} asset?`)) return;
    setError("");
    setIsDeleting(true);
    try {
      await onDelete(kind);
      setFile(null);
      setPreviewUrl("");
      setStatus("Removed · bundled fallback restored");
    } catch {
      setError("Removal failed. Try again.");
    } finally {
      setIsDeleting(false);
    }
  }

  const preview = previewUrl || currentUrl;
  const label = kind === "logo" ? "Logo asset" : "Favicon asset";
  const uploadDisabled = !file || isPreparing || isUploading || isDeleting;
  const uploadHelp = isPreparing
    ? "The image is still being prepared."
    : isUploading
      ? "The image is being uploaded."
      : isDeleting
        ? "Remove the current asset before uploading another one."
        : !file
          ? "Choose or drop an image before uploading."
          : "Upload the selected image.";

  return (
    <div className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="technical-label text-[var(--color-text-muted)]">{kind}</p>
          <h3 className="mt-1 text-sm font-bold">{label}</h3>
        </div>
        {currentUrl && (
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--color-text-muted)]">
              <CheckCircle2 aria-hidden="true" className="size-3.5 text-emerald-600" />
              Configured
            </span>
            <Button
              type="button"
              variant="ghost"
              aria-label={`Remove ${kind} asset`}
              title={`Remove ${kind} asset`}
              loading={isDeleting}
              disabled={isDeleting || isUploading || isPreparing}
              onClick={() => void remove()}
              className="size-8 rounded-md p-0 text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
            >
              <Trash2 aria-hidden="true" className="size-4" />
            </Button>
          </div>
        )}
      </div>
      <label
        htmlFor={inputId}
        onDragEnter={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) setIsDragging(false);
        }}
        onDrop={handleDrop}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            document.getElementById(inputId)?.click();
          }
        }}
        tabIndex={0}
        className={[
          "flex min-h-32 cursor-pointer items-center gap-4 rounded-lg border border-dashed p-4",
          "transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-ring)]",
          isDragging
            ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)]"
            : "border-[var(--color-border)] hover:border-[var(--color-primary)] hover:bg-[var(--color-surface-muted)]",
        ].join(" ")}
      >
        <input
          id={inputId}
          aria-label={label}
          className="sr-only"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/x-icon,.ico"
          onChange={(event) => void chooseFile(event.target.files?.[0])}
        />
        {preview ? (
          <span className="relative grid size-20 shrink-0 place-items-center overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)]">
            <Image
              src={preview}
              alt={`${label} preview`}
              fill
              unoptimized
              sizes="80px"
              className="object-contain p-2"
            />
          </span>
        ) : (
          <span className="grid size-20 shrink-0 place-items-center rounded-md bg-[var(--color-primary-soft)] text-[var(--color-primary-strong)]">
            <FileImage aria-hidden="true" className="size-8" />
          </span>
        )}
        <span className="min-w-0">
          <span className="block text-sm font-semibold">Drop an image here or browse files</span>
          <span className="mt-1 block text-xs leading-5 text-[var(--color-text-muted)]">
            PNG, JPEG, WebP or ICO · automatically optimized when possible
          </span>
        </span>
      </label>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-[var(--color-text-muted)]" aria-live="polite">
          {isPreparing ? "Preparing image…" : status || "No file selected"}
        </span>
        <span
          className={`group relative inline-flex${uploadDisabled ? " cursor-not-allowed" : ""}`}
          aria-describedby={uploadDisabled ? uploadTooltipId : undefined}
        >
          <Button
            type="button"
            variant="secondary"
            loading={isPreparing || isUploading}
            disabled={uploadDisabled}
            onClick={() => void upload()}
          >
            {isUploading ? (
              "Uploading…"
            ) : (
              <>
                <CloudUpload aria-hidden="true" className="size-4" />
                Upload asset
              </>
            )}
          </Button>
          {uploadDisabled ? (
            <span
              id={uploadTooltipId}
              role="tooltip"
              className="pointer-events-none invisible absolute bottom-full right-0 z-50 mb-2 w-60 rounded-md border border-[var(--color-border)] bg-[var(--color-text)] px-3 py-2 text-left text-xs font-normal leading-5 text-white opacity-0 shadow-lg transition-opacity group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100"
            >
              {uploadHelp}
            </span>
          ) : null}
        </span>
      </div>
      {error && <p className="text-xs font-semibold text-[var(--color-danger)]">{error}</p>}
    </div>
  );
}

export function ColorField({
  label,
  help,
  value,
  fallback,
  onChange,
}: {
  label: string;
  help?: string;
  value: string;
  fallback: string;
  onChange: (value: string) => void;
}) {
  const color = /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;

  return (
    <div className="grid gap-1 text-sm font-medium">
      <span className="flex items-center gap-1.5">
        {label}
        {help ? <HelpTooltip label={label} text={help} /> : null}
      </span>
      <div className="flex gap-2">
        <input
          aria-label={`${label} color picker`}
          type="color"
          value={color}
          onChange={(event) => onChange(event.target.value)}
          className="h-10 w-14 shrink-0 cursor-pointer rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-1"
        />
        <input
          aria-label={label}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="min-h-10 min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 font-normal text-[var(--color-text)]"
        />
      </div>
    </div>
  );
}

export function SettingsSection({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-6 border-b border-[var(--color-border)] pb-8 last:border-b-0">
      <header className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-[var(--color-primary-soft)] text-[var(--color-primary-strong)]">
          <Icon aria-hidden="true" className="size-5" />
        </span>
        <div>
          <h2 className="text-xl font-bold tracking-tight">{title}</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-[var(--color-text-muted)]">{description}</p>
        </div>
      </header>
      {children}
    </section>
  );
}

export function textValue(values: SettingValues, key: string, fallback = "") {
  return String(values[key] ?? fallback);
}

export function numberValue(values: SettingValues, key: string, fallback: number) {
  const value = values[key];
  return typeof value === "number" ? value : fallback;
}

export function megabytesValue(values: SettingValues, key: string, fallbackBytes: number) {
  return Number((numberValue(values, key, fallbackBytes) / (1024 * 1024)).toFixed(2));
}

export function readOnlyValue(value: unknown, key: string, fallback: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;

  const candidate = (value as Record<string, unknown>)[key];
  return candidate === undefined || candidate === null ? fallback : String(candidate);
}

export function dispatchManagedAssetUpdated(kind: ManagedAssetKind, url: string) {
  window.dispatchEvent(
    new CustomEvent(MANAGED_ASSET_UPDATED_EVENT, { detail: { kind, url } }),
  );
}

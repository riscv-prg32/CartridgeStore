export interface CartridgeApprovedEmailData {
  readonly recipientName: string;
  readonly gameTitle: string;
  readonly gameId: string;
  readonly version: string;
  readonly reviewerName: string;
  readonly storeName: string;
  readonly publicOrigin?: string;
  /** Absolute URL of the managed Store logo for HTML-capable mail clients. */
  readonly logoUrl?: string;
}

export interface RenderedEmailTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly variables: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly action?: {
    readonly label: string;
    readonly href: string;
  };
}

export type EmailTemplateSettings = {
  readonly approvalSubject: string;
  readonly approvalBody: string;
  readonly smtpTestSubject: string;
  readonly smtpTestBody: string;
};

export const DEFAULT_EMAIL_TEMPLATE_SETTINGS: EmailTemplateSettings = {
  approvalSubject: "{{gameTitle}} {{version}} was approved",
  approvalBody: "Good news: {{gameTitle}} {{version}} has been approved for {{storeName}}.\n\nReviewed by: {{reviewerName}}\nGame ID: {{gameId}}",
  smtpTestSubject: "{{storeName}} · SMTP test message",
  smtpTestBody: "This is a test message from {{storeName}}.\n\nYour SMTP connection is working and the Store can deliver transactional email.",
};

interface BrandedEmailOptions {
  readonly storeName: string;
  readonly logoUrl?: string;
  readonly preheader: string;
  readonly eyebrow: string;
  readonly title: string;
  readonly intro: string;
  readonly body: string;
  readonly action?: {
    readonly label: string;
    readonly href: string;
  };
}

const SAMPLE_APPROVAL: CartridgeApprovedEmailData = {
  recipientName: "Ivan",
  gameTitle: "Asteroids",
  gameId: "it.uniparthenope.asteroids",
  version: "1.0.0",
  reviewerName: "Store administrator",
  storeName: "PRG32 Cartridge Store",
  publicOrigin: "https://store.prg32.test",
};

export function renderCartridgeApprovedEmail(data: CartridgeApprovedEmailData, settings: EmailTemplateSettings = DEFAULT_EMAIL_TEMPLATE_SETTINGS): RenderedEmailTemplate {
  const gameUrl = data.publicOrigin === undefined
    ? undefined
    : new URL(`/games/${encodeURIComponent(data.gameId)}?version=${encodeURIComponent(data.version)}`, data.publicOrigin).toString();
  const greeting = data.recipientName.trim() ? `Hi ${data.recipientName.trim()},` : "Hello,";
  const context = {
    recipientName: data.recipientName.trim() || "there",
    gameTitle: data.gameTitle,
    gameId: data.gameId,
    version: data.version,
    reviewerName: data.reviewerName,
    storeName: data.storeName,
    publicOrigin: data.publicOrigin ?? "",
    publicUrl: gameUrl ?? "",
  };
  const subject = interpolate(settings.approvalSubject, context);
  const bodyText = interpolate(settings.approvalBody, context);
  const logoUrl = data.logoUrl ?? managedLogoUrl(data.publicOrigin);
  const publicLine = gameUrl === undefined ? "The cartridge is now visible in the public catalog." : `View it in the public catalog: ${gameUrl}`;
  const text = [
    greeting,
    "",
    bodyText,
    "",
    publicLine,
    `Reviewed by: ${data.reviewerName}`,
    `Game ID: ${data.gameId}`,
    "",
    `— ${data.storeName}`,
  ].join("\n");
  const html = brandedEmail({
    storeName: data.storeName,
    ...(logoUrl === undefined ? {} : { logoUrl }),
    preheader: `${data.gameTitle} ${data.version} was approved for ${data.storeName}.`,
    eyebrow: "CARTRIDGE / APPROVED",
    title: `${data.gameTitle} is approved`,
    intro: `${escapeHtml(greeting)} Your cartridge is now ready in the public catalog.`,
    body: [
      textToHtml(bodyText),
      `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:#f7f5fb;border:1px solid #e5e0ef;border-radius:10px;margin:0 0 22px;"><tr><td style="padding:16px 18px;"><p style="margin:0 0 8px;color:#716a83;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Release details</p><p style="margin:0;color:#28213a;"><strong>Version</strong> ${escapeHtml(data.version)}<br /><strong>Game ID</strong> ${escapeHtml(data.gameId)}<br /><strong>Reviewed by</strong> ${escapeHtml(data.reviewerName)}</p></td></tr></table>`,
    ].join(""),
    ...(gameUrl === undefined ? {} : { action: { label: "View cartridge", href: gameUrl } }),
  });
  return {
    id: "cartridge_approved",
    name: "Cartridge approved",
    description: "Sent to the publisher after an administrator approves a submitted cartridge.",
    variables: ["recipientName", "gameTitle", "gameId", "version", "reviewerName", "storeName", "publicOrigin", "publicUrl"],
    subject,
    text,
    html,
    ...(gameUrl === undefined ? {} : { action: { label: "View cartridge", href: gameUrl } }),
  };
}

export function renderSmtpTestEmail(storeName = "PRG32 Cartridge Store", logoUrl?: string, settings: EmailTemplateSettings = DEFAULT_EMAIL_TEMPLATE_SETTINGS): RenderedEmailTemplate {
  const resolvedStoreName = storeName.trim() || "PRG32 Cartridge Store";
  const bodyText = interpolate(settings.smtpTestBody, { storeName: resolvedStoreName });
  const text = ["Hello,", "", bodyText, "", `— ${resolvedStoreName}`].join("\n");
  const subject = interpolate(settings.smtpTestSubject, { storeName: resolvedStoreName });
  const html = brandedEmail({
    storeName: resolvedStoreName,
    ...(logoUrl === undefined ? {} : { logoUrl }),
    preheader: "Your PRG32 Cartridge Store SMTP connection is working.",
    eyebrow: "SMTP / CONNECTION CHECK",
    title: "Email delivery is working",
    intro: "This is a message generated by the Store email delivery check.",
    body: textToHtml(bodyText),
  });
  return {
    id: "smtp_test",
    name: "SMTP test message",
    description: "Sent from the Email delivery settings to verify the configured SMTP path.",
    variables: ["storeName"],
    subject,
    text,
    html,
  };
}

export function emailTemplatePreviews(settings: EmailTemplateSettings = DEFAULT_EMAIL_TEMPLATE_SETTINGS): readonly RenderedEmailTemplate[] {
  return [renderCartridgeApprovedEmail(SAMPLE_APPROVAL, settings), renderSmtpTestEmail(undefined, undefined, settings)];
}

function brandedEmail(options: BrandedEmailOptions): string {
  const action = options.action === undefined
    ? ""
    : `<table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:28px 0 6px;"><tr><td style="background:#b8f34a;border:3px solid #171225;box-shadow:4px 4px 0 #171225;"><a href="${escapeHtml(options.action.href)}" style="display:inline-block;padding:12px 18px;color:#171225;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:800;letter-spacing:1px;text-decoration:none;text-transform:uppercase;">▶ &nbsp;${escapeHtml(options.action.label)}</a></td></tr></table>`;
  const brandMark = options.logoUrl === undefined
    ? `<td style="width:34px;height:34px;border-radius:9px;background:#7044dc;color:#ffffff;font-size:21px;font-weight:700;line-height:34px;text-align:center;">P</td>`
    : `<td style="width:52px;height:38px;border-radius:9px;background:#171225;text-align:center;vertical-align:middle;"><img src="${escapeHtml(options.logoUrl)}" alt="PRG32" width="52" height="38" style="display:block;width:52px;height:38px;object-fit:contain;" /></td>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>${escapeHtml(options.title)}</title></head><body style="margin:0;background:#f5f3f8;color:#28213a;font-family:Arial,Helvetica,sans-serif;"><div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(options.preheader)}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:#f5f3f8;"><tr><td align="center" style="padding:32px 16px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;max-width:600px;"><tr><td style="padding:20px 24px;background:#2a2145;border-radius:12px 12px 0 0;"><table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse;"><tr>${brandMark}<td style="padding-left:11px;color:#ffffff;font-size:16px;font-weight:700;">${escapeHtml(options.storeName)}</td></tr></table></td></tr><tr><td style="padding:32px 32px 28px;background:#ffffff;border:1px solid #e5e0ef;border-top:0;border-radius:0 0 12px 12px;"><p style="margin:0;color:#7044dc;font-size:11px;font-weight:700;letter-spacing:1.5px;">${escapeHtml(options.eyebrow)}</p><h1 style="margin:10px 0 10px;color:#28213a;font-size:28px;line-height:1.2;letter-spacing:-0.5px;">${escapeHtml(options.title)}</h1><p style="margin:0 0 24px;color:#716a83;font-size:16px;line-height:1.6;">${options.intro}</p><div style="color:#403951;font-size:15px;line-height:1.7;">${options.body}</div>${action}<p style="margin:30px 0 0;padding-top:18px;border-top:1px solid #e5e0ef;color:#8a8398;font-size:12px;line-height:1.6;">This message was sent by ${escapeHtml(options.storeName)}. You can manage email delivery and notification settings from the developer dashboard.</p></td></tr></table></td></tr></table></body></html>`;
}

function managedLogoUrl(publicOrigin: string | undefined): string | undefined {
  if (publicOrigin === undefined) return undefined;
  try {
    return new URL("/api/assets/logo", publicOrigin).toString();
  } catch {
    return undefined;
  }
}

function interpolate(value: string, context: Record<string, string>): string {
  return value.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (_, key: string) => context[key] ?? "");
}

function textToHtml(value: string): string {
  return value
    .split(/\n\s*\n/)
    .map((paragraph) => `<p style="margin:0 0 18px;">${escapeHtml(paragraph).replaceAll("\n", "<br />")}</p>`)
    .join("");
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export type DocumentationBlock =
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] }
  | { type: "code"; language: string; value: string }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "links"; items: Array<{ label: string; href: string }> };

export type DocumentationArticle = {
  slug: string;
  title: string;
  summary: string;
  category: string;
  source: string;
  blocks: DocumentationBlock[];
};

const apiSource = "CartridgeStore/docs/api.md";
const firmwareSource = "../PRG32/docs/README.md and the linked public guides";

export const documentation: DocumentationArticle[] = [
  {
    slug: "getting-started",
    title: "Getting started",
    summary: "Understand the PRG32 platform, its two supported execution targets, and the Store workflow.",
    category: "Start here",
    source: firmwareSource,
    blocks: [
      { type: "paragraph", text: "PRG32 is a classroom platform for small cartridges that can run on physical ESP32-C6 hardware or in the QEMU workflow. Cartridge Store is the service for discovering published cartridges, downloading an architecture-specific binary, and exchanging optional scores and performance metrics." },
      { type: "paragraph", text: "Choose the firmware repository's getting-started guide for toolchain and board setup. This Store documentation focuses on the service boundary and the payloads exchanged with it." },
      { type: "table", headers: ["Target", "Identifier", "Use"], rows: [["ESP32-C6", "esp32c6", "Physical PRG32 hardware"], ["QEMU", "qemu", "Emulator and repeatable local development"]] },
      { type: "list", items: ["Browse published cartridges from the Store page.", "Open a cartridge to select a version and architecture before downloading.", "Use the developer workspace to submit a bundle for review when your account has publishing permission.", "Use the Scoreboard and Statistics pages for public read-only aggregates."] },
      { type: "links", items: [{ label: "Cartridge format", href: "/docs/cartridge-format" }, { label: "Publishing", href: "/docs/publishing" }, { label: "Store API", href: "/docs/store-api" }] },
    ],
  },
  {
    slug: "cartridge-format",
    title: "Cartridge format",
    summary: "The public bundle shape used when a cartridge is submitted to the Store.",
    category: "Cartridges",
    source: apiSource,
    blocks: [
      { type: "paragraph", text: "The Store accepts a ZIP bundle containing one manifest, an icon, an optional splash image, and one or more .prg32 binaries. The server validates the archive before staging it for review." },
      { type: "code", language: "text", value: "manifest.json\nicon.png\nsplash.png       optional\nmy-game-qemu.prg32\nmy-game-esp32c6.prg32" },
      { type: "paragraph", text: "Each architecture entry names the binary that belongs to that target. The Store keeps the identifier and version from the manifest stable through review and publication." },
      { type: "table", headers: ["Field", "Meaning"], rows: [["abi", "prg32-metadata-1.0"], ["id", "Stable cartridge identifier"], ["version", "Published version string"], ["architectures", "Target-specific binary entries"], ["assets.icon", "Icon filename in the bundle"]] },
      { type: "code", language: "json", value: "{\n  \"abi\": \"prg32-metadata-1.0\",\n  \"id\": \"org.example.game\",\n  \"title\": \"My Game\",\n  \"version\": \"1.0.0\",\n  \"assets\": {\"icon\": \"icon.png\"},\n  \"architectures\": [\n    {\"id\": \"qemu\", \"file\": \"game-qemu.prg32\"},\n    {\"id\": \"esp32c6\", \"file\": \"game-esp32c6.prg32\"}\n  ]\n}" },
      { type: "links", items: [{ label: "Metadata and ABI terminology", href: "/docs/metadata" }, { label: "Publishing workflow", href: "/docs/publishing" }] },
    ],
  },
  {
    slug: "metadata",
    title: "Metadata and compatibility",
    summary: "Stable public names used by Store discovery and cartridge metadata.",
    category: "Cartridges",
    source: "AGENTS.md and ../PRG32/docs/agents/metadata_consistency.md",
    blocks: [
      { type: "paragraph", text: "Metadata is part of the cartridge compatibility boundary. Consumers should preserve unknown fields and must not rename the established ABI identifiers." },
      { type: "table", headers: ["ABI name", "Purpose"], rows: [["prg32-metadata-1.0", "Cartridge bundle metadata"], ["prg32-colophon-1.0", "Published cartridge colophon data"], ["prg32-store-discovery-1.0", "Store discovery document"]] },
      { type: "paragraph", text: "The discovery document is available at /.well-known/prg32-store.json. It advertises the Store API and service URLs without requiring a frontend-specific contract." },
      { type: "code", language: "http", value: "GET /.well-known/prg32-store.json\nAccept: application/json" },
      { type: "links", items: [{ label: "Store API endpoints", href: "/docs/store-api" }, { label: "Cartridge format", href: "/docs/cartridge-format" }] },
    ],
  },
  {
    slug: "publishing",
    title: "Publishing workflow",
    summary: "Submit a bundle, then wait for editor review before it becomes public.",
    category: "Store workflow",
    source: apiSource,
    blocks: [
      { type: "paragraph", text: "Publishing is a review workflow. An authenticated developer uploads a ZIP bundle to /api/publish/bundle. A successful upload creates a pending submission; it does not immediately add the cartridge to the public catalog." },
      { type: "code", language: "http", value: "POST /api/publish/bundle\nContent-Type: multipart/form-data\n\nForm field: bundle=@game.zip" },
      { type: "list", items: ["The authenticated principal is recorded as the submission owner.", "Editors can inspect pending submissions and may adjust descriptive metadata fields.", "Verification publishes the accepted artifact; rejection leaves it out of the public catalog.", "The developer workspace shows only the authenticated user's ownership-scoped submission summaries."] },
      { type: "paragraph", text: "Browser session mutations require the session-bound CSRF token. Bearer/API-token clients use the documented token path and do not use browser CSRF state." },
      { type: "links", items: [{ label: "Developer workspace", href: "/workspace" }, { label: "Store API", href: "/docs/store-api" }] },
    ],
  },
  {
    slug: "multiplayer",
    title: "Multiplayer",
    summary: "Connect to the Store's same-origin WebSocket relay using the PRG32 frame vocabulary.",
    category: "Runtime APIs",
    source: apiSource,
    blocks: [
      { type: "paragraph", text: "The multiplayer relay is exposed at /api/multiplayer on the Store host. The relay carries small JSON messages and keeps the WebSocket on the same HTTP origin as the rest of the service." },
      { type: "code", language: "json", value: "{\"type\":\"join\",\"signature\":\"pong-v1\",\"flags\":1,\"player_id\":123}\n{\"type\":\"state\",\"x\":120,\"y\":80,\"sprite\":0,\"flags\":0,\"input\":2,\"frame\":42}\n{\"type\":\"leave\"}" },
      { type: "paragraph", text: "Signatures may contain letters, digits, underscore, hyphen, dot, and colon within the documented length limit. Check /api/multiplayer/status before presenting multiplayer controls." },
      { type: "links", items: [{ label: "Discovery document", href: "/docs/store-api" }, { label: "Firmware documentation", href: "https://github.com/riscv-prg32/PRG32" }] },
    ],
  },
  {
    slug: "scores",
    title: "Scores",
    summary: "Read and submit score records without merging player names with authenticated identities.",
    category: "Runtime APIs",
    source: "../PRG32/docs/score_api.md and " + apiSource,
    blocks: [
      { type: "paragraph", text: "GET /api/scores returns score records. The Store orders results by score descending and then created_at ascending, so the Scoreboard presents that returned order rather than calculating a new ranking algorithm." },
      { type: "code", language: "http", value: "GET /api/scores?game=pong&player=Ada&limit=20" },
      { type: "table", headers: ["Field", "Meaning"], rows: [["game", "Cartridge/game identifier supplied by the client"], ["player", "Player label supplied with the score"], ["score", "Unsigned 32-bit score value"], ["created_at", "Unix timestamp assigned by the Store"]] },
      { type: "paragraph", text: "Anonymous player labels, authenticated users, and firmware player identifiers are distinct concepts. The UI displays the player field as submitted and does not infer account ownership." },
      { type: "links", items: [{ label: "Open scoreboard", href: "/scores" }, { label: "Statistics", href: "/stats" }] },
    ],
  },
  {
    slug: "metrics",
    title: "Metrics and runs",
    summary: "Understand the bounded run and sample contracts used for performance measurements.",
    category: "Runtime APIs",
    source: "../PRG32/docs/measurement/metrics_api.md and backend/src/metrics/service.ts",
    blocks: [
      { type: "paragraph", text: "The optional streaming metrics pipeline records runs and frame samples. Run detail, sample exports, and report exports are protected by the API's owner/admin authorization policy. Public statistics therefore use only the aggregate /api/stats/runs response." },
      { type: "table", headers: ["Field", "Unit or meaning"], rows: [["frame_us", "Microseconds of frame work"], ["update_us / draw_us / present_us", "Stage durations in microseconds"], ["fps_x100", "FPS multiplied by 100 in raw samples"], ["deadline_missed", "Whether a sample missed its deadline"], ["dropped_samples", "Samples not retained by the run"]] },
      { type: "code", language: "http", value: "GET /api/runs\nGET /api/runs/<run_id>\nGET /api/runs/<run_id>/samples.csv\nGET /api/runs/<run_id>/report.md" },
      { type: "paragraph", text: "The Store UI does not convert private sample series into a public chart and does not treat missing samples as zero. Authenticated owner-facing run visualization can be added when its product route is explicitly scoped." },
      { type: "links", items: [{ label: "Statistics aggregates", href: "/stats" }, { label: "Firmware metrics guide", href: "https://github.com/riscv-prg32/PRG32/blob/main/docs/measurement/metrics_api.md" }] },
    ],
  },
  {
    slug: "store-api",
    title: "Store API",
    summary: "A concise map of the public read and workflow endpoints used by the Storefront.",
    category: "Reference",
    source: apiSource,
    blocks: [
      { type: "table", headers: ["Method", "Path", "Purpose"], rows: [["GET", "/api/games", "List published cartridges"], ["GET", "/api/games/<id>", "Read cartridge metadata"], ["GET", "/api/games/<id>/download", "Download a selected binary"], ["GET", "/api/scores", "Read scores"], ["GET", "/api/stats/downloads", "Read download aggregates"], ["GET", "/api/stats/scores", "Read bounded top scores"], ["GET", "/api/stats/runs", "Read aggregate run counters"], ["GET", "/api/multiplayer/status", "Read relay status"], ["WS", "/api/multiplayer", "Open the relay"]] },
      { type: "paragraph", text: "The Storefront calls the public Fastify API origin directly. It does not access SQLite directly or depend on private storage boundaries for public statistics." },
      { type: "paragraph", text: "For authentication, publishing, review, CSRF, and the complete request/response examples, use the repository's full API reference. The Storefront documentation intentionally omits private infrastructure configuration and maintainer-only runbooks." },
      { type: "code", language: "http", value: "GET /.well-known/prg32-store.json\nGET /api/games\nGET /api/scores?game=pong&limit=20\nGET /api/stats/downloads?granularity=day&limit=30" },
    ],
  },
];

export function getDocumentationArticle(slug: string): DocumentationArticle | undefined {
  return documentation.find((article) => article.slug === slug);
}

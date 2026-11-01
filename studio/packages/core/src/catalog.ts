// Pure option catalogs shared by the engine, the worker and the browser UI.
// Keep this module free of Node built-ins so client components can import it.

export const TARGET_KINDS = [
  {
    id: "web",
    label: "Web app",
    description: "A live site reached by URL, optionally behind a login.",
  },
  {
    id: "javascript",
    label: "Electron / JavaScript app",
    description: "An .asar archive, an extracted app folder or a JS bundle.",
  },
  {
    id: "android",
    label: "Android APK",
    description: "An APK file analyzed statically with REA's Android tools.",
  },
  {
    id: "native",
    label: "Native binary",
    description:
      "A macOS, Windows or Linux executable. Needs Ghidra, Hopper or IDA.",
  },
] as const;

export type TargetKind = (typeof TARGET_KINDS)[number]["id"];

export const ACCESS_MODES = [
  { id: "none", label: "No login", description: "The target is public." },
  {
    id: "password",
    label: "Username and password",
    description: "The agent signs in through the UI using secret references.",
  },
  {
    id: "storage",
    label: "Cookies",
    description: "Paste exported cookies as JSON; values stay encrypted.",
  },
  {
    id: "connect",
    label: "I will sign in myself",
    description:
      "Studio attaches to a Chrome you started with a loopback debugging port (for MFA/CAPTCHA).",
  },
] as const;

export type AccessMode = (typeof ACCESS_MODES)[number]["id"];

export const SCOPE_MODES = [
  { id: "full", label: "Whole application" },
  { id: "feature", label: "One feature" },
  { id: "api", label: "API / backend only" },
] as const;

export type ScopeMode = (typeof SCOPE_MODES)[number]["id"];

export const LANGUAGES = [
  {
    id: "rust",
    label: "Rust",
    frameworks: ["Axum", "Actix Web", "Leptos", "Tauri", "CLI (clap)"],
  },
  {
    id: "go",
    label: "Go",
    frameworks: ["net/http + chi", "Gin", "Fiber", "CLI (cobra)"],
  },
  {
    id: "python",
    label: "Python",
    frameworks: ["FastAPI", "Django", "Flask", "CLI (typer)"],
  },
  {
    id: "typescript",
    label: "TypeScript",
    frameworks: ["Next.js", "Hono", "NestJS", "Express"],
  },
  { id: "java", label: "Java", frameworks: ["Spring Boot", "Quarkus"] },
  { id: "csharp", label: "C#", frameworks: ["ASP.NET Core", "Blazor"] },
  { id: "kotlin", label: "Kotlin", frameworks: ["Ktor", "Jetpack Compose"] },
  { id: "swift", label: "Swift", frameworks: ["Vapor", "SwiftUI"] },
] as const;

export type LanguageId = (typeof LANGUAGES)[number]["id"];

export const HARDENING_OPTIONS = [
  { id: "tests", label: "Automated tests" },
  { id: "security", label: "Security hardening" },
  { id: "accessibility", label: "Accessibility" },
  { id: "performance", label: "Performance" },
] as const;

export type HardeningId = (typeof HARDENING_OPTIONS)[number]["id"];

export const PROVIDERS = [
  {
    id: "openai",
    label: "OpenAI",
    needsApiKey: true,
    baseURL: "optional",
    defaultBaseURL: "https://api.openai.com/v1",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    needsApiKey: true,
    baseURL: "optional",
    defaultBaseURL: "https://api.anthropic.com/v1",
  },
  {
    id: "google",
    label: "Google Gemini",
    needsApiKey: true,
    baseURL: "optional",
    defaultBaseURL: "https://generativelanguage.googleapis.com/v1beta",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    needsApiKey: true,
    baseURL: "optional",
    defaultBaseURL: "https://openrouter.ai/api/v1",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    needsApiKey: false,
    baseURL: "optional",
    defaultBaseURL: "http://127.0.0.1:11434/api",
  },
  {
    id: "openai-compatible",
    label: "OpenAI-compatible (DeepSeek, Groq, Mistral, vLLM, LM Studio…)",
    needsApiKey: false,
    baseURL: "required",
    defaultBaseURL: "",
  },
] as const;

export type ProviderId = (typeof PROVIDERS)[number]["id"];

export const PHASES = [
  { id: "analysis", label: "Analysis" },
  { id: "spec", label: "Specification" },
  { id: "build", label: "Build" },
  { id: "verify", label: "Verification" },
  { id: "report", label: "Report" },
] as const;

export type PhaseId = (typeof PHASES)[number]["id"];

export const isTargetKind = (value: unknown): value is TargetKind =>
  TARGET_KINDS.some((kind) => kind.id === value);

export const isProviderId = (value: unknown): value is ProviderId =>
  PROVIDERS.some((provider) => provider.id === value);

export const providerInfo = (id: ProviderId) =>
  PROVIDERS.find((provider) => provider.id === id) ?? PROVIDERS[0];

import type {
  ChatCompletionMessage,
  ChatCompletionRequest,
  OpenAIError,
} from "../types/openai.js";

export interface ValidateResult {
  ignoredParams: string[];
}

export interface TransformError {
  error: OpenAIError;
}

export interface BuildPromptResult {
  prompt: string;
  systemPrompt?: string;
}

export interface BuildCliArgsOptions {
  outputFormat: "json" | "stream-json";
  prompt: string;
  systemPrompt?: string;
  resolvedModel: string;
  sessionId: string;
  sessionAction: "created" | "resumed";
  useStdin?: boolean;
  streaming?: boolean;
}

// Tier 3: unsupported params that cause a 400 error
const TIER_3_PARAMS: string[] = [
  "tools",
  "tool_choice",
  "functions",
  "function_call",
  "response_format",
  "logprobs",
  "top_logprobs",
  "logit_bias",
];

// Tier 2: accepted but ignored params (logged via header)
const TIER_2_PARAMS: string[] = [
  "temperature",
  "top_p",
  "max_tokens",
  "stop",
  "seed",
  "frequency_penalty",
  "presence_penalty",
];

export function validateParams(
  request: ChatCompletionRequest,
): ValidateResult | TransformError {
  // Check n > 1 (Tier 3)
  const n = request.n as number | undefined;
  if (n !== undefined && n > 1) {
    return {
      error: {
        error: {
          message:
            "Parameter 'n' with value greater than 1 is not supported. Only n=1 is allowed.",
          type: "invalid_request_error",
          param: "n",
          code: "unsupported_parameter",
        },
      },
    };
  }

  // Check Tier 3 params
  for (const param of TIER_3_PARAMS) {
    if (request[param] !== undefined) {
      return {
        error: {
          error: {
            message: `Parameter '${param}' is not supported by the Claude Code backend.`,
            type: "invalid_request_error",
            param,
            code: "unsupported_parameter",
          },
        },
      };
    }
  }

  // Collect Tier 2 ignored params
  const ignoredParams: string[] = [];
  for (const param of TIER_2_PARAMS) {
    if (request[param] !== undefined) {
      ignoredParams.push(param);
    }
  }

  // n=1 is accepted but ignored
  if (n === 1) {
    ignoredParams.push("n");
  }

  return { ignoredParams };
}

export function buildPrompt(
  messages: ChatCompletionMessage[],
  isResume: boolean,
): BuildPromptResult {
  // Extract system messages
  const systemMessages = messages.filter((m) => m.role === "system");
  const systemPrompt =
    systemMessages.length > 0
      ? systemMessages
          .map((m) => (typeof m.content === "string" ? m.content : ""))
          .join("\n\n")
      : undefined;

  // Get non-system messages
  const nonSystemMessages = messages.filter((m) => m.role !== "system");

  if (nonSystemMessages.length === 0) {
    throw new Error("No user or assistant messages provided");
  }

  // Resume session -> last user message only
  if (isResume) {
    const userMessages = nonSystemMessages.filter((m) => m.role === "user");
    if (userMessages.length === 0) {
      throw new Error("No user messages provided for resume");
    }
    const lastMessage = userMessages[userMessages.length - 1]!;
    const content =
      typeof lastMessage.content === "string"
        ? lastMessage.content
        : JSON.stringify(lastMessage.content);
    if (!content) {
      throw new Error("Empty message content");
    }
    return { prompt: content, systemPrompt };
  }

  // Single user message -> content as-is
  if (nonSystemMessages.length === 1) {
    const msg = nonSystemMessages[0]!;
    const content =
      typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content);
    if (!content) {
      throw new Error("Empty message content");
    }
    return { prompt: content, systemPrompt };
  }

  // Multi-turn -> labeled format
  const parts: string[] = [];
  for (const msg of nonSystemMessages) {
    const label = msg.role === "user" ? "User" : "Assistant";
    const content =
      typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content);
    parts.push(`${label}: ${content}`);
  }

  return { prompt: parts.join("\n"), systemPrompt };
}

export function buildCliArgs(options: BuildCliArgsOptions): string[] {
  const args: string[] = [
    "--output-format",
    options.outputFormat,
    "--model",
    options.resolvedModel,
    "--dangerously-skip-permissions",
  ];

  // Disable tools
  args.push("--tools", "");

  // Session handling
  if (options.sessionAction === "created") {
    args.push("--session-id", options.sessionId);
  } else {
    args.push("--resume", options.sessionId);
  }

  // System prompt
  if (options.systemPrompt) {
    args.push("--system-prompt", options.systemPrompt);
  }

  // Streaming-specific flags
  if (options.streaming) {
    args.push("--verbose", "--include-partial-messages");
  }

  // Prompt via -p flag (unless using stdin for large prompts)
  if (!options.useStdin) {
    args.push("-p", options.prompt);
  }

  return args;
}

const ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "ANTHROPIC_API_KEY"];

const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export function buildSanitizedEnv(
  env?: Record<string, string | undefined>,
): Record<string, string> {
  const source = env ?? process.env;
  const result: Record<string, string> = {
    TERM: "dumb",
  };

  for (const key of ENV_ALLOWLIST) {
    if (source[key]) {
      result[key] = source[key]!;
    }
  }

  // Fallbacks per section 7.2
  if (!result.HOME) {
    result.HOME = "/tmp";
  }

  if (!result.PATH) {
    result.PATH = DEFAULT_PATH;
  }

  if (!result.LANG) {
    result.LANG = "en_US.UTF-8";
  }

  return result;
}

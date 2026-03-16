import {
  DEFAULT_ACCOUNT_ID,
  listWecomKfAccountIds,
  mergeWecomKfAccountConfig,
  resolveDefaultWecomKfAccountId,
} from "./config.js";
import type { PluginConfig, WecomKfConfig } from "./types.js";
import { getAccountState } from "./state.js";

export interface WizardPrompter {
  note: (message: string, title?: string) => Promise<void>;
  text: (opts: {
    message: string;
    placeholder?: string;
    initialValue?: string;
    validate?: (value: string | undefined) => string | undefined;
  }) => Promise<string | symbol>;
  confirm: (opts: { message: string; initialValue?: boolean }) => Promise<boolean>;
}

function isPromptCancelled<T>(value: T | symbol): value is symbol {
  return typeof value === "symbol";
}

function setAccountConfig(params: {
  cfg: PluginConfig;
  accountId: string;
  nextConfig: Record<string, unknown>;
}): PluginConfig {
  const existing = params.cfg.channels?.["wecom-kf"] ?? {};
  if (params.accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        "wecom-kf": {
          ...existing,
          ...params.nextConfig,
          enabled: true,
        } as WecomKfConfig,
      },
    };
  }

  const accounts = (existing as WecomKfConfig).accounts ?? {};
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      "wecom-kf": {
        ...existing,
        enabled: true,
        accounts: {
          ...accounts,
          [params.accountId]: {
            ...accounts[params.accountId],
            ...params.nextConfig,
            enabled: true,
          },
        },
      } as WecomKfConfig,
    },
  };
}

async function noteWecomKfHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) 在微信客服管理后台开启 API",
      "2) 获取企业 ID 和微信客服 Secret",
      "3) 配置回调 URL、Token、EncodingAESKey",
      "4) 将客服账号授权给可调用接口的自建应用",
      "5) 记录 open_kfid，用于主动回发消息",
    ].join("\n"),
    "WeCom KF 配置"
  );
}

export const wecomKfOnboardingAdapter = {
  channel: "wecom-kf" as const,

  getStatus: async (params: { cfg: PluginConfig }) => {
    const accountId = resolveDefaultWecomKfAccountId(params.cfg);
    const merged = mergeWecomKfAccountConfig(params.cfg, accountId);
    const state = await getAccountState(accountId);
    const configured = Boolean(
      merged.corpId?.trim() &&
        merged.corpSecret?.trim() &&
        merged.token?.trim() &&
        merged.encodingAESKey?.trim()
    );

    return {
      channel: "wecom-kf" as const,
      configured,
      statusLines: [
        configured
          ? `WeCom KF: 已配置${accountId !== DEFAULT_ACCOUNT_ID ? ` (${accountId})` : ""}`
          : "WeCom KF: 需要 corpId / corpSecret / token / encodingAESKey",
        `Webhook: ${(merged.webhookPath ?? "/wecom-kf").trim() || "/wecom-kf"}`,
        `Cursor: ${state.hasCursor ? "已建立" : "未建立"}`,
        state.lastError ? `最近错误: ${state.lastError}` : "最近错误: 无",
      ],
      selectionHint: configured ? "已配置" : "需要基础凭证",
      quickstartScore: configured ? 2 : 0,
    };
  },

  configure: async (params: {
    cfg: PluginConfig;
    prompter: WizardPrompter;
    accountOverrides?: Record<string, string>;
  }) => {
    const requestedAccountId = params.accountOverrides?.["wecom-kf"]?.trim();
    const accountIds = listWecomKfAccountIds(params.cfg);
    const accountId =
      requestedAccountId ||
      (accountIds.length > 0 ? resolveDefaultWecomKfAccountId(params.cfg) : DEFAULT_ACCOUNT_ID);
    const merged = mergeWecomKfAccountConfig(params.cfg, accountId);

    await noteWecomKfHelp(params.prompter);

    const corpId = await params.prompter.text({
      message: "请输入企业 ID (corpId)",
      initialValue: merged.corpId,
      validate: (value) => (String(value ?? "").trim() ? undefined : "corpId 不能为空"),
    });
    if (isPromptCancelled(corpId)) return { cfg: params.cfg, accountId };

    const corpSecret = await params.prompter.text({
      message: "请输入微信客服 Secret",
      validate: (value) => (String(value ?? "").trim() ? undefined : "corpSecret 不能为空"),
    });
    if (isPromptCancelled(corpSecret)) return { cfg: params.cfg, accountId };

    const openKfId = await params.prompter.text({
      message: "请输入客服账号 ID (open_kfid)",
      initialValue: merged.openKfId,
      validate: (value) => (String(value ?? "").trim() ? undefined : "open_kfid 不能为空"),
    });
    if (isPromptCancelled(openKfId)) return { cfg: params.cfg, accountId };

    const token = await params.prompter.text({
      message: "请输入回调 Token",
      validate: (value) => (String(value ?? "").trim() ? undefined : "token 不能为空"),
    });
    if (isPromptCancelled(token)) return { cfg: params.cfg, accountId };

    const encodingAESKey = await params.prompter.text({
      message: "请输入回调 EncodingAESKey",
      validate: (value) => (String(value ?? "").trim() ? undefined : "encodingAESKey 不能为空"),
    });
    if (isPromptCancelled(encodingAESKey)) return { cfg: params.cfg, accountId };

    const webhookPath = await params.prompter.text({
      message: "请输入 webhookPath",
      initialValue: merged.webhookPath ?? "/wecom-kf",
      validate: (value) => (String(value ?? "").trim() ? undefined : "webhookPath 不能为空"),
    });
    if (isPromptCancelled(webhookPath)) return { cfg: params.cfg, accountId };

    return {
      cfg: setAccountConfig({
        cfg: params.cfg,
        accountId,
        nextConfig: {
          corpId: String(corpId).trim(),
          corpSecret: String(corpSecret).trim(),
          openKfId: String(openKfId).trim(),
          token: String(token).trim(),
          encodingAESKey: String(encodingAESKey).trim(),
          webhookPath: String(webhookPath).trim(),
        },
      }),
      accountId,
    };
  },

  disable: (cfg: PluginConfig): PluginConfig => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      "wecom-kf": {
        ...(cfg.channels?.["wecom-kf"] as WecomKfConfig | undefined),
        enabled: false,
      },
    },
  }),
};

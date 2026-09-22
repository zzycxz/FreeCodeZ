import type { ProviderConfigObject } from "@zcode/provider";
import { PackageIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { resolveTheme, type ResolvedTheme } from "@/useTheme.js";
import alibabaModelStudioLogo from "@/assets/provider-icons/model-provider-alibaba-cloud.png";
import anthropicLogo from "@/assets/provider-icons/model-provider-anthropic.png";
import bigModelLogo from "@/assets/provider-icons/logo-bigmodel.svg";
import volcengineLogo from "@/assets/provider-icons/model-provider-volcengine.svg";
import stepfunLogo from "@/assets/provider-icons/model-provider-stepfun.svg";
import xfyunLogo from "@/assets/provider-icons/model-provider-xfyun.svg";
import siliconflowLogo from "@/assets/provider-icons/model-provider-siliconflow.svg";
import baiduQianfanLogo from "@/assets/provider-icons/model-provider-baidu-qianfan.svg";
import tencentHunyuanLogo from "@/assets/provider-icons/model-provider-tencent-hunyuan.svg";
import ollamaLogo from "@/assets/provider-icons/model-provider-ollama.svg";
import lmStudioLogo from "@/assets/provider-icons/model-provider-lm-studio.svg";
import llamacppLogo from "@/assets/provider-icons/model-provider-llamacpp.svg";
import momaLogo from "@/assets/provider-icons/model-provider-moma.svg";
import aliyunBailianLogo from "@/assets/provider-icons/model-provider-aliyun-bailian.svg";
import deepSeekLogo from "@/assets/provider-icons/model-provider-deepseek.png";
import miniMaxLogo from "@/assets/provider-icons/model-provider-minimax.png";
import moonshotKimiLogo from "@/assets/provider-icons/model-provider-moonshot-kimi.png";
import openAiLogo from "@/assets/provider-icons/model-provider-openai.png";
import xAiLogo from "@/assets/provider-icons/model-provider-xai.png";
import xiaomiMimoLogo from "@/assets/provider-icons/model-provider-xiaomi-mimo.png";
import startPlanLogo from "@/assets/provider-icons/model-provider-start-plan.png";
import zaiLogo from "@/assets/provider-icons/model-provider-zai-app.png";
import openrouterLight from "@/assets/provider-icons/model-provider-openrouter-light.svg";
import openrouterDark from "@/assets/provider-icons/model-provider-openrouter-dark.svg";
import opencodeLight from "@/assets/provider-icons/model-provider-opencode-light.svg";
import opencodeDark from "@/assets/provider-icons/model-provider-opencode-dark.svg";

type ProviderLogoRef = NonNullable<ProviderConfigObject["logo"]>;

interface BuiltinProviderLogoAsset {
  readonly light: string;
  readonly dark?: string;
}

// 这里只负责把 Config 中的资源 key 解析为打包素材；禁止加入 Provider ID、名称或排序逻辑。
const BUILTIN_PROVIDER_LOGO_ASSETS: Readonly<Record<string, BuiltinProviderLogoAsset>> = {
  // 用户指定 Dock 应用图标；同名旧 SVG 带灰色描边，不能当作同一素材复用。
  zai: { light: zaiLogo },
  bigmodel: { light: bigModelLogo },
  "start-plan": { light: startPlanLogo },
  "moonshot-kimi": { light: moonshotKimiLogo },
  minimax: { light: miniMaxLogo },
  deepseek: { light: deepSeekLogo },
  "alibaba-model-studio": { light: alibabaModelStudioLogo },
  "xiaomi-mimo": { light: xiaomiMimoLogo },
  openai: { light: openAiLogo },
  anthropic: { light: anthropicLogo },
  xai: { light: xAiLogo },
  openrouter: { light: openrouterLight, dark: openrouterDark },
  opencode: { light: opencodeLight, dark: opencodeDark },
  // P2 新厂商品牌标：品牌主色渐变 + 首字母（非官方 logo 复刻，规避商标风险）；
  // 批次 D 订阅端点复用同品牌素材（bailian×2 / qianfan×2 / tencent×2 / stepfun×2 / xfyun×2）。
  volcengine: { light: volcengineLogo },
  stepfun: { light: stepfunLogo },
  xfyun: { light: xfyunLogo },
  siliconflow: { light: siliconflowLogo },
  "baidu-qianfan": { light: baiduQianfanLogo },
  "tencent-hunyuan": { light: tencentHunyuanLogo },
  ollama: { light: ollamaLogo },
  "lm-studio": { light: lmStudioLogo },
  llamacpp: { light: llamacppLogo },
  moma: { light: momaLogo },
  "aliyun-bailian": { light: aliyunBailianLogo },
};

function resolveBuiltinProviderLogoAsset(
  logo: ProviderLogoRef | null | undefined,
  theme: ResolvedTheme,
): string | null {
  if (logo?.type !== "builtin") {
    return null;
  }
  const asset = BUILTIN_PROVIDER_LOGO_ASSETS[logo.key];
  return asset ? (theme === "dark" ? (asset.dark ?? asset.light) : asset.light) : null;
}

/** 素材是否已打包命中；未命中时调用方给字母 monogram 兜底（无素材孤儿，B7）。 */
export function hasBuiltinProviderLogo(key: string | null | undefined): boolean {
  return Boolean(key && BUILTIN_PROVIDER_LOGO_ASSETS[key]);
}

export function ProviderLogo({
  logo,
  className,
}: {
  logo?: ProviderLogoRef | null;
  className?: string;
}) {
  const theme = useZCodeStoreWithDefault((state) => state.theme, "zai-dark");
  const src = resolveBuiltinProviderLogoAsset(logo, resolveTheme(theme));
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (!src || failedSrc === src) {
    return <PackageIcon className={cn("shrink-0", className)} aria-hidden="true" />;
  }
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      className={cn("shrink-0 object-contain", className)}
      onError={() => setFailedSrc(src)}
    />
  );
}

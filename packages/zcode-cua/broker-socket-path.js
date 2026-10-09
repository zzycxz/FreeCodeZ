// R16.1：mint 供宿主侧凭据归属校验使用（品牌化默认路径，忽略 env 显式覆盖），
// resolve 仍是连接方完整语义（env 覆盖优先）。两者同源于 ./broker.js 固定命名。
export { mintBrokerSocketPath, resolveBrokerSocketPath } from "./broker.js";

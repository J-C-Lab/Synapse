# 插件签名与校验 —— 设计 (Design)

> 创建于 2026-06-10。仓库:`sunzrnobug/Synapse`,单 `main` 分支。
> 范围:为插件安装引入**发布者真实性**(authenticity)。当前只有完整性(`sha256`)。
> 本设计**只覆盖签名/校验**;市场后端(真服务器 vs 形式化 git 注册表)与渲染层代码分割(B3)是独立后续,见末尾「范围外」。

## 1. 目标与威胁模型

- **目标**:在安装时证明「这个插件包确实由声称的发布者签发,且发布后未被篡改」,覆盖**市场安装**与**本地 `.syn` 导入**两条路径。
- **防御的威胁**:
  - 篡改包内代码(已签名包被改一个文件)。
  - 冒名(包自声明 `publisherId=com.acme` 但用攻击者的密钥)。
  - 借市场渠道凭空建立信任(上传自签名包绕过注册表锚)。
  - 夹带未签名文件(包里多塞一个不在签名清单里的文件)。
  - 路径绕过(签名清单里的路径与解压落盘路径不一致;`..`/绝对路径/盘符/反斜杠)。
  - **ZIP/文件系统层绕过**:重复条目、symlink/hardlink/设备文件等非普通文件、大小写折叠碰撞(Windows 不敏感)、同一规范化路径被多条目写入。
  - **降级攻击**:客户端被诱导读到 v1 注册表,回退到仅 sha256 的旧逻辑、绕过签名。
- **不在威胁模型内**:运行时沙箱逃逸(已有 vm 沙箱处理)、供应链攻击发布者自己的私钥泄露(发布者责任)。

## 2. 锁定的决策

1. **信任模型**:注册表锚定发布者密钥 + 本地信任库(本地导入遇未知发布者走 TOFU)。
2. **范围**:两条安装路径都覆盖;签名**内嵌**进 `.syn` 包。
3. **未签名策略**:invalid 永远拒;市场要求已签名;本地未签名→警告+显式确认;valid 但发布者未知(本地)→TOFU;dev 来源豁免。
4. **rollout**:方案 A —— registry v1 维持 legacy(仅 sha256)行为,registry v2 起强制 publisher 签名。签名体系可独立合入,不阻塞现有 mock marketplace。
5. **加密**:Ed25519,经 Node 内置 `crypto`,零新原生依赖。

## 3. 加密与编码

- 算法:Ed25519(`crypto.generateKeyPair('ed25519')` / `sign(null, data, key)` / `verify(null, data, key, sig)`)。
- 公钥编码:统一 **base64(SPKI DER)**。私钥:PKCS8 PEM(发布者本地持有)。
- 指纹:`fingerprint = sha256(SPKI DER 原始字节)`,以**小写十六进制**展示。**绝不**对 PEM 文本或混合编码算指纹。
- 哈希:文件摘要 `sha256-<base64>`(带算法前缀,便于未来升级)。

## 4. 包签名格式

已签名 `.syn` 多带一个条目 `META-INF/synapse-signature.json`:

```jsonc
{
  "format": 1,
  "publisherId": "com.acme",
  "publisherName": "Acme Inc.",          // 仅展示,非安全依据
  "publicKey": "<base64(SPKI DER)>",
  "alg": "ed25519",
  "files": {
    "manifest.json": "sha256-<base64>",
    "dist/index.js": "sha256-<base64>"
  },
  "signature": "<base64 Ed25519>"        // 不在签名覆盖内
}
```

- `signedPayload = canonicalJson({ format, publisherId, publisherName, publicKey, alg, files })`
- `signature = sign(signedPayload, privateKey)`
- **所有参与信任判断的字段(含 `publicKey`、`alg`)都在签名覆盖内**,杜绝「重要字段作为未签名元数据被使用」。
- `files` 覆盖包内除 `META-INF/synapse-signature.json` 外的**每一个文件条目**(目录条目忽略)。
- **严格 schema**:签名文件用 zod `.strict()` 解析,**拒绝任何未知 top-level 字段**(如有人塞 `"trusted": true`、`"registryPublisher": …`),`files` 也不允许非字符串值等未知结构。防止后续维护者误把包内自声明字段当安全依据。验证器**只**从这组已知字段重建 `signedPayload`。

## 5. Canonical JSON

不用裸 `JSON.stringify`(key 序不稳)。规则:

1. **object key 必须是 ASCII**;出现非 ASCII key → 抛错(见下)。
2. object key 按普通字典序(`String.prototype` 比较)递归排序。**因为 key 限定 ASCII,JS 的 UTF-16 code-unit 序与 Unicode 码点序一致**,绕开「`.sort()` 非码点序」的坑(评审采纳方案 B)。
3. 拒绝 `undefined`、`NaN`、`Infinity`(出现即抛错);
4. 字符串用 JSON 标准转义;
5. 数组保持顺序;
6. 输出 UTF-8 字节后再签名/验签。

`files` 这层嵌套 object 的 key 同样排序。签名 JSON 的字段名本就是固定英文;`files` 的 path 经 §6 规范化后也是 ASCII 安全路径,故 ASCII 约束不损表达力。

## 6. 路径规范化与安全解压

### 6.1 `normalizePackageEntryName(name): string | null`

`files` 的每个 key、以及解压落盘路径,都过同一函数(与既有 `resolveZipEntryPath` 同一套规则)。返回 `null` 即拒。拒绝:

- `..` 段、绝对路径(`/...`)、盘符(`C:\...`、`c:/...`)、反斜杠 `\`、`\0`;
- **非 ASCII 字符**(与 §5 的 ASCII-key 约束一致);
- 目录条目作为 `files` key(目录不该出现在签名清单);
- `META-INF/synapse-signature.json` 自身。

通过的 key 一律标准 POSIX 相对路径。

### 6.2 集合级冲突(在 `files` 全集上检查)

- **规范化后重复**:两个不同写法映射到同一落盘路径 → invalid。
- **大小写折叠碰撞**:两个不同 key 在 `toLowerCase()` 折叠后相同(如 `dist/index.js` 与 `dist/INDEX.js`)→ invalid。**跨平台统一拒绝**(不只 Windows),让签名器与验证器行为一致,杜绝大小写不敏感 FS 上的覆盖/混淆。

### 6.3 安全解压(extraction = 第一道安全闸)

不是「先随便解压、再校验 staging」,而是**读 ZIP entry → 规范化/判类型 → 拒危险 entry → 才写盘**。现有 `extractSynapsePackage` 已做 entry 级路径穿越校验且用 `wx`(已存在即失败);本设计把它显式收紧为:

- 每个 entry 名先过 `normalizePackageEntryName`,`null` 即整包拒(`invalid`)。
- **只接受普通文件**:拒绝 symlink / hardlink / 目录冒充文件 / 设备文件 / FIFO 等(经 ZIP entry 的 external attributes / unix mode 判定;**绝不**因 entry 携带的 mode 而创建 symlink)。
- **同一规范化路径被多个 entry 写入 → invalid**(干净拒绝,而非依赖 `wx` 抛 `EEXIST` 的脏失败);大小写折叠碰撞同样拒(见 6.2)。
- `META-INF/synapse-signature.json` 出现多次 → invalid。
- 落盘后做文件摘要时用 **`lstat`(不 follow symlink)**;遇非普通文件即拒。

**签名时算 hash 的路径 == 解压落盘的路径**,不允许错位。这样「路径绕过 / 文件系统层绕过」威胁闭环在解压阶段就堵死,签名校验只在已净化的 staging 上进行。

## 7. 校验纯核心 `verifyPackageSignature(stagingDir)`

返回 `{ status:"valid", publisherId, publicKey, fingerprint }` | `{ status:"unsigned" }` | `{ status:"invalid", reason }`。

**顺序固定(任一步失败 → `invalid`,且 `unsigned` 仅当签名文件缺失):**

1. 读 `META-INF/synapse-signature.json`;不存在 → `unsigned`。
2. **pin 校验**:`alg === "ed25519"`;`files` 每个值以 `sha256-` 开头。未知 alg / 未知 hash 前缀 → `invalid`(防降级/混淆)。
3. 重建 `signedPayload`(去 `signature` 字段)→ `canonicalJson` → 用 **`payload.publicKey`** 验 Ed25519 签名。失败 → `invalid`。
4. 对 `files` 每个 key 跑 `normalizePackageEntryName`,任一非法 → `invalid`。
5. 枚举 staging 实际文件(staging 已由 §6.3 净化:无 symlink/特殊文件/重复/大小写碰撞;忽略目录),与 `files` 做**集合相等性**:多(包里有清单没有)、少(清单有包里没有)→ `invalid`;逐项用 `lstat` 确认普通文件后重算 `sha256-<base64>` 与清单比对,不符 → `invalid`。
6. 至此 `status="valid"`,产出 `{ publisherId, publicKey, fingerprint }`。**这些字段此刻才可信**(全在签名覆盖内)。

> `valid` ≠ 可信。可信由策略层凭锚点(registryPublisher / 已信任 trustStore)判定。自签名包会有「对自己 publicKey 的有效签名」,因此有效签名本身不代表任何信任。

## 8. 信任库 PublisherTrustStore

- 落盘:`userData/plugins/publisher-trust.json`,复用 atomic-json-store。
- 形状:
  ```jsonc
  { "publishers": { "com.acme": {
      "name": "Acme Inc.",
      "publicKey": "<base64(SPKI DER)>",
      "fingerprint": "<sha256 hex>",
      "source": "registry" | "tofu",
      "trustedAt": 1718000000000
  } } }
  ```
- 方法:`get(publisherId)`、`add(entry, source)`、`list()`、`seedFromRegistry(publishers[])`(幂等;同 id 已存在且 key 不同 → **不覆盖、不报错,返回冲突标记供策略层 reject**)。
- 加载丢弃损坏项。

## 9. 策略决策 `decidePluginInstall`(纯函数)

签名:
```ts
decidePluginInstall(
  verification: VerificationResult,
  ctx: {
    installMode: "marketplace" | "localPackage" | "devDirectory"
    trustStore: { get(id): TrustedPublisher | undefined }
    registryPublisher?: { publisherId: string; publicKey: string } // 仅 marketplace 传
  }
): { action: "allow" }
 | { action: "reject"; reason: string }
 | { action: "confirm"; kind: "unsigned" | "tofu"; publisherId?: string; fingerprint?: string }
```

**矩阵(锁死,逐行覆盖测试):**

| installMode | 签名状态 | 发布者状态 | 决策 |
|-------------|---------|-----------|------|
| devDirectory | 任意 | — | **allow**,且**完全退出签名信任子系统**(见下) |
| marketplace | unsigned | — | reject |
| marketplace | invalid | — | reject |
| marketplace | valid | `registryPublisher` 缺失 | reject |
| marketplace | valid | 包内 `publisherId`/`publicKey` ≠ `registryPublisher` | reject |
| marketplace | valid | 与 `registryPublisher` 完全一致 | allow(seed trustStore,语义见下) |
| localPackage | invalid | — | reject |
| localPackage | unsigned | — | confirm(kind:"unsigned") |
| localPackage | valid | trustStore 有该 id 且 key 一致 | allow |
| localPackage | valid | trustStore 有该 id 但 key 不同 | **reject**(已知发布者被冒充) |
| localPackage | valid | trustStore 无该 id | confirm(kind:"tofu", 带 fingerprint) → 确认后 `add(..,"tofu")` |

**全局不变量(优先级最高,先于矩阵其它分支判定;仅 `marketplace` + `localPackage`):**

- **一个 `publisherId` 全局只对应一个 `publicKey`**。在 `marketplace` / `localPackage` 下,若 `trustStore` 已有该 `publisherId` 且其 key 与包内 `publicKey` 不同 → **reject**("publisher key mismatch"),不 TOFU、不 confirm。这把「已知发布者被冒充」的防护对两条信任路径生效(含 marketplace:即使 `registryPublisher` 匹配,但本地 trustStore 与包不一致仍 reject —— registry 与 trustStore 必须对该 id 达成一致)。
- 推论:`seedFromRegistry` 遇「同 id 已存在但 key 不同」时不覆盖、返回冲突标记;该 id 的 marketplace 安装因上面的不变量被 reject,需人工核查(撤销旧信任或修正注册表)。

**devDirectory 与不变量无冲突(消歧):** `devDirectory` **不读、不写、不信任、不持久化**任何签名身份 —— 它压根不调用 `verifyPackageSignature` 做信任判断,也不碰 `trustStore`,更不参与 TOFU、不作为 marketplace 信任依据。因此「key mismatch → reject」对它**不适用**(它从不进入信任判定)。dev 包带不带签名、key 是否冲突,都只是「显式开发来源,直接放行运行」。

**marketplace allow 后的 seed 语义(收紧):**

- seed 写入 `source:"registry"`。
- 若 trustStore 已有同 id **不同 key** → 命中上面的全局不变量,**reject、不覆盖**(不会发生静默覆盖本地 TOFU 的 keyA 为 registry 的 keyB)。
- 若已有同 id **相同 key** → 幂等刷新 `name`/`trustedAt`;`source` 若原为 `tofu` 可升格为 `registry`。
- 若不存在 → 新增。

**约束(来自评审,显式写死):**

- **C1**:marketplace 严格模式必须以 `registryPublisher` 为锚,**不得仅依赖本地 trustStore**(否则 TOFU 信任会污染市场判断)。注:这与上面的全局不变量并不冲突 —— 锚是 `registryPublisher`,trustStore 仅作为「冲突即拒」的额外约束,不作为「批准」的依据。
- **C2**:`registryPublisher.publisherId` 与 `registryPublisher.publicKey` 必须与包内 `signedPayload` 的对应字段**完全一致**,否则 reject。
- **C3**:registry v1 宽松路径命名为 **legacy compatibility**(见 §10),**必须有测试覆盖**,防止长期沦为隐性后门。
- **C4**:TOFU 只允许 `localPackage`;TOFU 成功后,同一 `publisherId` 出现不同 key 必须 reject(走「已知但 key 不同」分支)。
- **C5**:`devDirectory` 豁免只限显式开发目录(discovery 的 `dev` 源 / 文件夹安装),**不适用**于普通 `.syn` 包,也不适用于自动更新包。

## 10. 注册表 v2 与 rollout(方案 A)

- `marketplace-registry.ts` 的 `registrySchema` 支持 `version: 1 | 2`。
- **v2** 新增顶层 `publishers: [{ id, name, publicKey(SPKI DER b64) }]`,每个 plugin 条目加 `publisherId`(zod 校验必须 ∈ `publishers` 的 id 集)。
- `sha256`(下载完整性)保留;签名是叠加的真实性。
- **enforcement 由 registry version 决定**:
  - **registry v1(legacy compatibility)**:沿用今天 —— 仅 sha256,**不**走签名闸。命名清晰、测试覆盖(C3)。
  - **registry v2**:市场安装强制走 §9 的 marketplace 严格分支,锚 `publishers` 里该 plugin 的 publisher。
- 本地 `.syn` 导入**始终**走签名闸(与 registry version 无关)。
- 迁移:把仓库里的 mock 注册表升 v2 + 给 mock 插件签名,是**后续(市场后端)**的事,不阻塞本设计合入。

**防降级收敛(避免 legacy 变长期后门,评审采纳):**

- legacy(v1)宽松路径**只对内置 mock 注册表 / 显式 legacy 源生效**;生产默认 `DEFAULT_MARKETPLACE_REGISTRY_URL` 必须是 v2。
- **反回滚(anti-rollback)**:持久化「曾见过的最高 registry version」;一旦见过 v2,后续读到 v1 → **拒绝并告警**(视为降级攻击),不静默回退。
- 配置开关 `allowLegacyRegistry` 默认仅开发环境开启;生产开启需显式配置并记 warning + 设定 sunset 时间。
- C3 的「测试覆盖」防的是 legacy 变成**隐性**后门;这里的收敛防的是它变成**长期显性**后门。

## 11. 集成接入点

- **校验闸位置**:`PluginHost` 的 `installMarketplacePlugin` 与 `installPackage` 都「解压到 staging → `installDirectory` 提升」。闸插在**解压之后、提升之前**:
  - `verifyPackageSignature(stagingDir)` → `decidePluginInstall(...)`。
  - `allow` → 提升;`reject` → 抛 `PluginSignatureError(reason)` 并清理 staging;`confirm`/`tofu` → 走 §12 确认,通过才提升(TOFU 通过再 `trustStore.add`)。
  - 市场安装传 `installMode:"marketplace"` + `registryPublisher`(从 v2 注册表查该 plugin 的 publisher);v1 注册表不进闸(legacy)。
  - 本地导入传 `installMode:"localPackage"`。
  - 文件夹/dev 安装传 `installMode:"devDirectory"`。
- **安装与更新共用同一签名闸**:任何插件更新包(将来若引入插件自动更新)必须重新跑 `verifyPackageSignature` + `decidePluginInstall`,**不得**走 `devDirectory` 豁免,且受同 `publisherId` key 一致约束。杜绝「更新路径绕过安装校验」。(当前尚无插件级自动更新机制,此为前置不变量。)

## 12. 确认 / TOFU 往返(主进程原生 dialog)

- 市场永不弹窗(未签/未知/不匹配直接 reject)。
- 本地导入需要确认时,主进程用原生 `dialog.showMessageBox`(模态),**重点展示 `publisherId` + fingerprint + 来源**(「本地导入,首次见到」),而非突出自声明名称:
  - `kind:"unsigned"`:「该插件未签名,无法验证来源,是否仍要安装?」
  - `kind:"tofu"`:「首次见到发布者 `<publisherId>`(指纹 `<fingerprint>`),是否信任并安装?」
- **`publisherName` 展示优先级**(防 `publisherName:"Microsoft"` + `publisherId:"evil.plugin"` 的视觉冒名):
  - marketplace:用 registry 中该 publisher 的 name;
  - localPackage 首次 TOFU:可显示包内 `publisherName`,但**必须标注「自声明名称」**,且不作为视觉主体;
  - trustStore 已存在:用 trustStore 中的 name。
- 选原生模态:安全关键步骤放主进程,**渲染层无法伪造/绕过**,且无需 pending-token 状态机。代价:UX 不如内嵌弹窗统一(本地导入低频,可接受)。

## 13. 共享纯模块 `@synapse/plugin-signing`

新 workspace 包,纯 TS、只依赖 `node:crypto`、**无 Electron**。导出:`canonicalJson`、`normalizePackageEntryName`、`fingerprint`、`signPackageDigest`、`verifyPackageSignature`、相关类型。

**main 与 plugin-cli 都 import 同一份**,保证签名器与验证器永不漂移(单一事实源)。`decidePluginInstall`(纯函数)+ 信任库 I/O 留在 `src/main/plugins/`。

代价:多一个 workspace 包 —— 换来 sign/verify 对称性,值得。

## 14. 发布者 CLI(`@synapse/plugin-cli` 加三命令)

- `synapse-plugin keygen` → Ed25519 keypair;私钥写 `synapse-private-key.pem`(PKCS8,提示加 `.gitignore`)+ 打印公钥(SPKI DER b64)+ fingerprint(供提交注册表)。
- `synapse-plugin sign [dir]` → 复用 `zip.ts`/`build.ts` 算文件摘要 → 构造 `signedPayload` → 私钥签名 → 内嵌 `META-INF/synapse-signature.json` → 产出已签 `.syn`(已存在签名条目则拒)。
- `synapse-plugin verify <pkg>` → 调 `@synapse/plugin-signing` 的 `verifyPackageSignature`,作者自检。
- `create-synapse-plugin` 模板 + 新 `SIGNING.md` 文档。

## 15. 测试矩阵(TDD)

- **`@synapse/plugin-signing`**:
  - `canonicalJson` 确定性(key 序无关;拒 `NaN`/`Infinity`/`undefined`;**拒非 ASCII key**)。
  - `normalizePackageEntryName`:接受合法;拒 `..`/绝对/反斜杠/盘符/`\0`/非 ASCII/目录项/签名文件本身。
  - 集合级:**规范化后重复路径 → invalid**;**大小写折叠碰撞(`dist/index.js` vs `dist/INDEX.js`)→ invalid**。
  - sign→verify 往返(测试内生成临时 keypair)。
  - 篡改检测:改文件 hash、夹带多文件、缺文件、错 `alg`、错 hash 前缀、坏签名 → 各 `invalid`;缺签名文件 → `unsigned`。
  - **未知字段**:签名 JSON 多出 `trusted`/`registryPublisher`/任意 extra → `invalid`(strict schema)。
- **安全解压**(评审重点,前 3 类最关键):
  - **ZIP 重复条目**:两个 `dist/index.js`;两个 `META-INF/synapse-signature.json` → 整包拒。
  - **大小写碰撞**:ZIP 含 `dist/index.js` 与 `dist/INDEX.js` → 拒。
  - **symlink / 非普通文件**:ZIP 含 symlink/设备文件 → 拒;hash 阶段 `lstat` 不 follow symlink。
- **`decidePluginInstall`**:§9 矩阵**每一行**;显式覆盖 C1–C5(尤其 C3 legacy、C4 TOFU 后 key-mismatch、key-mismatch 两条路径都 reject);**devDirectory 不写 trustStore、不参与 TOFU**。
- **PublisherTrustStore**:注册表 seed、TOFU 追加、跨实例持久、key-mismatch 冲突标记、损坏项丢弃;**local unsigned confirm 通过后不写 trustStore**(未签名包不得变成隐式可信发布者)。
- **注册表 schema / 防降级**:v1 解析(legacy,无 publishers)、v2 解析(publisherId 必须 ∈ publishers)、v2 校验失败用例;**已见 v2 后读到 v1 → reject/warning(anti-rollback)**;生产 mode 下 v1 被拒。
- **CLI**:keygen/sign/verify 往返;sign 拒已签包。
- **Host 集成**:已签 fixture 装得上;未签 fixture 市场 reject / 本地走 confirm;`registryPublisher` 不匹配 reject。
- **TOFU 弹窗内容**:确认展示 `fingerprint`(不只 `publisherName`)。

## 16. 范围外(独立后续)

- **市场后端**:真服务器 vs 形式化 git 注册表 + 发布流水线(含把 mock 注册表升 v2、给内置插件签名)。本设计为其提供了 v2 schema 与验证地基。
- **B3 渲染层代码分割**:主 bundle 1.8MB 单块按路由懒加载(recharts、chat/markdown/shiki 栈)。纯构建优化,与本设计无关。

## 17. 实施顺序(TDD 友好,分阶段落地)

设计较大,分 5 阶段实现,每阶段先测后码、可独立合入:

- **Phase 1 — 纯核心**(`@synapse/plugin-signing`):`canonicalJson`(ASCII-key)、`normalizePackageEntryName`、集合级冲突检测、`fingerprint`、`verifyPackageSignature`(签名/篡改/未知字段)+ 单测。
- **Phase 2 — 安全解压与 staging 校验**:ZIP entry 规范化、重复路径拒、大小写碰撞拒、symlink/特殊文件拒、`lstat` 哈希、文件集合相等性 + 单测(含前述「最关键的前 3 类」)。
- **Phase 3 — 主进程策略层**:`PublisherTrustStore`、`decidePluginInstall`(全矩阵 + C1–C5 + 全局不变量)、`PluginSignatureError`、接入 `installPackage` / `installMarketplacePlugin`、§12 原生确认弹窗。
- **Phase 4 — 发布者 CLI**:`keygen` / `sign` / `verify`;`create-synapse-plugin` 模板 + `SIGNING.md`。
- **Phase 5 — 注册表 v2**:`publishers` schema + `publisherId` 锚、marketplace `registryPublisher` 接线、v1 legacy 收敛 + 反回滚。

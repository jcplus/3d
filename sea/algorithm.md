# 实时海洋波形生成算法参考

本文档提炼了实时海洋渲染中的核心算法，可作为其他项目的独立参考实现。

---

## 1. 核心波形算法：绝对尖峰 Gerstner 波

> 注：自 M4 起，现行 L0 深海高度场已改用 FFT 频谱海洋（见 §15）。本节及 §2、§12 描述的
> 尖峰 Gerstner 叠加作为历史参考保留，可独立用于不需要 FFT 的轻量场景。

传统 Gerstner 波使用正弦函数产生平滑波形，本算法通过 **绝对值变换** 产生数学意义上的尖锐波峰。

### 1.1 数学原理

```
基础波形:  baseShape = 1.0 - |sin(f)|
          
其中 f = k * (dot(d, worldPos) - c * time) + phase
      k = 2π / wavelength  (波数)
      c = √(g/k)           (波速，g=9.8)
      d = 归一化波方向
```

**关键洞察**：`1.0 - |sin(x)|` 在 `x = 0, π, 2π...` 处产生数学尖点（不可导点），形成绝对尖锐的浪尖。

### 1.2 尖峰控制

```
peakK = 1.0 + stormIntensity * 3.0   // 范围: 1.0(三角形) -> 4.0(极尖锐)
shaped = pow(baseShape, peakK)       // 幂函数控制尖锐度
```

| peakK 值 | 效果 |
|---------|------|
| 1.0 | 线性三角形波 |
| 2.0 | 抛物线形，较圆润 |
| 3.0+ | 极度尖锐，适合暴风雨 |

### 1.3 振幅映射

```
a = steepness / k   // 基础振幅
h = shaped * a      // 最终高度 (波谷在0，波峰在a)

// 减去平均高度保持海平面平衡
height = h - 0.3 * a
```

### 1.4 水平位移（可选）

```
horizontalFactor = cos(f) * steepness * 0.5
position.x += d.x * horizontalFactor * a * weight
position.z += d.y * horizontalFactor * a * weight
```

### 1.5 完整伪代码实现

```glsl
// 参数说明
// worldPos: 世界坐标 (xz平面)
// direction: 波的传播方向
// steepness: 陡度 (0.0-0.85，安全上限)
// wavelength: 波长
// speed: 速度倍数
// phaseOffset: 相位偏移
// stormIntensity: 风暴强度 (0.0-1.0)
// waveIndex: 波的层级索引 (0, 1, 2...)

void calculateWave(
    vec2 worldPos, vec2 direction, float steepness, 
    float wavelength, float speed, float phaseOffset,
    float stormIntensity, float waveIndex,
    inout vec3 displacement, inout float jacobian
) {
    float k = 2.0 * PI / wavelength;
    float c = sqrt(9.8 / k);
    vec2 d = normalize(direction);
    
    float f = k * (dot(d, worldPos) - c * time * speed) + phaseOffset;
    float a = steepness / k;
    
    // === 绝对尖峰核心 ===
    float baseShape = 1.0 - abs(sin(f));
    float peakK = 1.0 + stormIntensity * 3.0;
    float shaped = pow(baseShape, peakK);
    
    // 垂直位移
    float weight = pow(1.0 - clamp(waveIndex / 10.0, 0.0, 1.0), 2.0);
    displacement.y += (shaped - 0.3) * a * weight;
    
    // 水平位移（可选）
    float cosf = cos(f);
    displacement.x += d.x * cosf * steepness * a * 0.5 * weight;
    displacement.z += d.y * cosf * steepness * a * 0.5 * weight;
    
    // Jacobian 用于泡沫生成
    jacobian += steepness * k * baseShape * weight;
}
```

---

## 2. 多波叠加系统

### 2.1 层级参数迭代

```
初始值:
  wLen = 30.0 + pow(windSpeed, 1.55)  // 基础波长与风速相关
  steep = 0.25 * choppiness            // 基础陡度
  speed = 1.0 + stormIntensity * 0.6   // 基础速度

每层迭代 (i = 0 到 11，共12层):
  wLen *= 0.58     // 波长指数衰减
  steep *= 0.82    // 陡度衰减
  speed *= 1.07    // 速度微增
  
  // 方向随机化
  chaos = 0.3 + i * 0.1 + stormIntensity * 0.5
  dir = rotate(mainWindDir, random() * chaos * 2.5)
  
  // 大浪增强（前3层）
  if (i < 3) swellBoost = 1.0 + stormIntensity * 1.8
```

### 2.2 Domain Warping（域变形）

在波浪计算前添加低频变形，打破规则感：

```glsl
vec2 warp = vec2(
    sin(worldPos.y * 0.005 + time * 0.1),
    cos(worldPos.x * 0.005 + time * 0.1)
);
worldPos += warp * 15.0;  // 应用变形
```

---

## 3. 泡沫生成算法

### 3.1 Jacobian 行列式法

泡沫产生于波浪折叠（overturning）处，数学上对应 Jacobian 矩阵行列式小于1的区域。

```
J = 1.0 - jacobianSum

if J < threshold:  产生泡沫
```

### 3.2 时间累积模型

使用双缓冲纹理实现帧间累积：

```glsl
// 读取上一帧泡沫
float prevFoam = texture2D(foamTexture, uv).r;

// 当前帧生成量
float generation = smoothstep(threshold, threshold - 0.2, jacobian);
generation = clamp(generation, 0.0, 1.0) * 0.15;

// 累积与衰减
float foam = prevFoam * decay + generation;
foam = clamp(foam, 0.0, 1.0);
```

| 参数 | 建议值 | 说明 |
|-----|-------|------|
| decay | 0.94-0.98 | 每帧衰减系数，越大泡沫持续时间越长 |
| threshold | 0.6-0.9 | 产生泡沫的 Jacobian 阈值 |

---

## 4. 法线重建算法

### 4.1 从位移图实时计算

不存储法线贴图，而是从位移图实时采样计算：

```glsl
// 假设纹理分辨率 256x256
float texelSize = 1.0 / 256.0;

// 采样邻居
vec3 displacement = texture2D(displacementMap, uv).rgb;
vec3 right = texture2D(displacementMap, uv + vec2(texelSize, 0.0)).rgb;
vec3 down = texture2D(displacementMap, uv + vec2(0.0, texelSize)).rgb;

// 网格实际间距
float gridStep = gridSize / resolution;  // 如: 1000.0 / 256.0

// 切线向量
vec3 tangentX = vec3(gridStep, 0.0, 0.0) + (right - displacement);
vec3 tangentZ = vec3(0.0, 0.0, gridStep) + (down - displacement);

// 法线 = 切线叉积
vec3 normal = normalize(cross(tangentZ, tangentX));
```

---

## 5. 海底地形：分形布朗运动 (FBM)

### 5.1 多层 Simplex Noise 叠加

```glsl
float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    float frequency = 1.0;
    
    for(int i = 0; i < 5; i++) {
        value += amplitude * snoise(p * frequency);
        amplitude *= 0.5;     //  persistence = 0.5
        frequency *= 2.0;     //  lacunarity = 2.0
    }
    return value;
}

// 应用
float height = fbm(worldPos * 0.01) * 20.0 + seabedLevel;
```

### 5.2 法线计算

```glsl
float eps = 1.0;
float hL = fbm((worldPos - vec2(eps, 0.0)) * 0.01);
float hR = fbm((worldPos + vec2(eps, 0.0)) * 0.01);
float hD = fbm((worldPos - vec2(0.0, eps)) * 0.01);
float hU = fbm((worldPos + vec2(0.0, eps)) * 0.01);

vec3 normal = normalize(vec3(hL - hR, 2.0 * eps, hD - hU));
```

---

## 6. 焦散效果算法

### 6.1 Voronoi 细胞噪声

```glsl
vec2 hash2(vec2 p) {
    return fract(sin(vec2(
        dot(p, vec2(127.1, 311.7)), 
        dot(p, vec2(269.5, 183.3))
    )) * 43758.5453);
}

float voronoi(vec2 x) {
    vec2 n = floor(x);
    vec2 f = fract(x);
    float md = 8.0;
    
    // 遍历邻居格子
    for(int j = -1; j <= 1; j++) {
        for(int i = -1; i <= 1; i++) {
            vec2 g = vec2(float(i), float(j));
            vec2 o = hash2(n + g);
            // 添加动画
            o = 0.5 + 0.5 * sin(time * 0.5 + 6.2831 * o);
            vec2 r = g + o - f;
            md = min(md, dot(r, r));
        }
    }
    return md;  // 返回到最近特征点的距离平方
}

// 使用
float caustics = voronoi(worldPos * 0.1);
caustics = pow(1.0 - caustics, 3.0) * 0.8;
```

### 6.2 Domain Warped 焦散

```glsl
vec2 warp = vec2(
    sin(coord.y * 2.0 + time * 0.5) * 0.2,
    cos(coord.x * 2.0 + time * 0.3) * 0.2
);
float caustics2 = voronoi(coord + warp);
```

---

## 7. 水面渲染效果

### 7.1 Fresnel 效应

```glsl
vec3 viewDir = normalize(cameraPos - worldPos);
float fresnel = pow(1.0 - max(dot(viewDir, normal), 0.0), 5.0);
fresnel = mix(0.02, 1.0, fresnel);  // 基础反射率 2%
```

### 7.2 水深散射

```glsl
float scatter = max(dot(viewDir, -normal), 0.0);
vec3 waterColor = mix(deepColor, shallowColor, scatter * 0.5 + 0.5);
```

### 7.3 高光反射

```glsl
vec3 halfDir = normalize(viewDir + sunDir);
float specAngle = max(dot(normal, halfDir), 0.0);
float specular = pow(specAngle, 128.0) * 0.8;
```

---

## 8. GPGPU 计算管线架构

### 8.1 双变量系统

```
┌─────────────────┐     ┌─────────────────┐
│ Physics Variable│────▶│  Foam Variable  │
│ (位移+Jacobian) │     │ (泡沫累积)      │
└─────────────────┘     └─────────────────┘
         │                       │
         ▼                       ▼
┌─────────────────┐     ┌─────────────────┐
│  Displacement   │     │   Foam Texture  │
│    Texture      │     │                 │
└─────────────────┘     └─────────────────┘
```

### 8.2 依赖关系

```
Physics: 无依赖 (每帧独立计算)
Foam: 依赖上一帧的 Foam + 当前 Physics
```

### 8.3 数据流

```glsl
// Physics Shader 输出
gl_FragColor = vec4(displacementX, displacementY, displacementZ, jacobian);

// Foam Shader 输入/输出
vec4 physics = texture2D(texturePhysics, uv);
float jacobian = physics.a;
float prevFoam = texture2D(textureFoam, uv).r;
// ... 计算 ...
gl_FragColor = vec4(newFoam, 0.0, 0.0, 1.0);
```

---

## 9. 参数速查表

### 9.1 波浪参数

| 参数 | 符号 | 典型值 | 说明 |
|-----|------|-------|------|
| 风速 | windSpeed | 5-35 | 影响波长和浪高 |
| 陡度 | choppiness | 0.8-2.0 | 控制波的尖锐程度 |
| 风暴强度 | stormIntensity | 0.0-1.0 | 内部计算值，影响尖峰度 |
| 波层数 | waveCount | 12 | 叠加的波数量 |
| 波长衰减 | lambda | 0.58 | 每层波长乘以该系数 |

### 9.2 泡沫参数

| 参数 | 符号 | 典型值 | 说明 |
|-----|------|-------|------|
| 衰减率 | decay | 0.96 | 每帧保留的泡沫比例 |
| 阈值 | threshold | 0.8 | Jacobian 小于此值产生泡沫 |

### 9.3 网格参数

| 参数 | 符号 | 典型值 | 说明 |
|-----|------|-------|------|
| 网格大小 | gridSize | 1000 | 世界空间尺寸 |
| 分辨率 | resolution | 256-512 | 纹理/顶点分辨率 |

---

## 10. 独立使用示例

### 10.1 最小化波浪计算（伪代码）

```javascript
class WaveGenerator {
    constructor() {
        this.time = 0;
        this.windSpeed = 22;
        this.windDirection = new Vector2(1, 0);
        this.choppiness = 1.5;
    }
    
    // 计算单个点的波浪高度
    getHeight(worldX, worldZ) {
        const worldPos = new Vector2(worldX, worldZ);
        
        // Domain Warping
        const warp = new Vector2(
            Math.sin(worldZ * 0.005 + this.time * 0.1),
            Math.cos(worldX * 0.005 + this.time * 0.1)
        );
        worldPos.add(warp.multiplyScalar(15));
        
        let height = 0;
        let wLen = 30 + Math.pow(this.windSpeed, 1.55);
        let steep = 0.25 * this.choppiness;
        
        const stormIntensity = Math.min(Math.max((this.windSpeed - 5) / 30, 0), 1);
        
        for (let i = 0; i < 12; i++) {
            // 随机方向（实际实现需要确定性随机）
            const angle = this.hash(i) * (0.3 + i * 0.1 + stormIntensity * 0.5) * 2.5;
            const dir = this.rotate(this.windDirection, angle);
            
            // 绝对尖峰计算
            const k = 2 * Math.PI / wLen;
            const c = Math.sqrt(9.8 / k);
            const f = k * (dir.dot(worldPos) - c * this.time) + this.hash(i + 100) * 100;
            const a = steep / k;
            
            const baseShape = 1 - Math.abs(Math.sin(f));
            const peakK = 1 + stormIntensity * 3;
            const shaped = Math.pow(baseShape, peakK);
            
            const weight = Math.pow(1 - Math.min(i / 10, 1), 2);
            height += (shaped - 0.3) * a * weight;
            
            // 迭代
            wLen *= 0.58;
            steep *= 0.82;
        }
        
        return height;
    }
}
```

---

## 11. 无限海面与泡沫重投影

让固定大小的网格跟随相机移动，营造无边界海面。核心是三个配合的机制。

### 11.1 整 patch 吸附（防 swimming）

网格每帧吸附到相机所在的整 patch 位置，而不是连续跟随：

```
patchSize = gridSize / gridResolution     // 一个网格单元的世界尺寸
offset.x  = floor(camera.x / patchSize) * patchSize
offset.z  = floor(camera.z / patchSize) * patchSize
mesh.position.xz = offset
```

**关键**：按整 patch 步进保证每个顶点的世界坐标始终落在固定的世界格点上，
顶点采样到的波形值帧间连续，不会产生"游泳感"（swimming）。
连续跟随则会让顶点在波形函数上滑动，整个海面看起来粘在相机上。

### 11.2 物理用绝对世界坐标

波形是世界坐标的函数。物理 compute shader 接收网格偏移，把纹理 UV 还原为世界坐标：

```glsl
uniform vec2 uGridOffset;   // = mesh.position.xz

vec2 worldPos = (uv - 0.5) * uGridSize + uGridOffset;
// 之后所有波形计算照旧，平移天然无缝
```

Domain Warping 等基于位置的扰动同样自动正确，因为它们也吃 worldPos。

### 11.3 泡沫 UV 重投影

泡沫是帧间累积量，存在网格局部 UV 空间里。网格移动后，同一 UV 对应的世界位置变了，
直接采样上帧泡沫会让泡沫整体跟着网格漂移。解法是采样时按偏移差重投影：

```
uUVOffset = (offset_now - offset_prev) / gridSize   // 本帧相对上帧的位移，UV 单位
```

```glsl
uniform vec2 uUVOffset;

vec2 prevUv = uv + uUVOffset;
float prevFoam = 0.0;
if (prevUv.x >= 0.0 && prevUv.x <= 1.0 &&
    prevUv.y >= 0.0 && prevUv.y <= 1.0) {
    prevFoam = texture2D(textureFoam, prevUv).r;
}
// 越界 = 新进入视野的区域，没有历史泡沫，从 0 开始累积
```

推导：世界点 W 在本帧的 UV 是 `(W - offset_now)/gridSize + 0.5`，
在上帧是 `(W - offset_prev)/gridSize + 0.5`，二者之差正是 `uUVOffset`。

### 11.4 UV 轴向约定陷阱

three.js 的 `PlaneGeometry` 经 `rotateX(-π/2)` 放平后，顶点局部坐标
`z = (0.5 - v) * size` —— V 轴与世界 Z 轴**反向**。而 compute shader 里习惯写
`worldPos = (uv - 0.5) * gridSize`（V 与 Z 同向）。网格静止时这只是波场镜像，
看不出问题；网格一移动，两个约定的偏移方向就会打架（Z 向波浪滚动方向错误）。

统一约定的最简做法是在建网格时翻转一次 V：

```javascript
const uvAttr = geometry.attributes.uv;
for (let i = 0; i < uvAttr.count; i++) {
    uvAttr.setY(i, 1.0 - uvAttr.getY(i));
}
```

此后纹理 V 与世界 Z 同向，物理、泡沫重投影、粒子采样共用同一套公式。

### 11.5 配套细节

- **粒子系统**：粒子位置存网格局部坐标，整个 `Points` 对象与网格一起吸附平移，
  采样 UV 公式不变。
- **片元世界坐标效果**：依赖世界坐标的着色细节（如泡沫气泡噪声）必须用
  `vWorldPosition` 而不是 UV，否则图案会跟着网格跳动。
- **海底跟随**：地形高度若是世界坐标的函数（如 `fbm(worldPos)`），海底网格按
  自己的 patch 尺寸吸附即可，地形自动稳定。

---

## 12. 频谱分带与前倾浪峰（M1.5）

### 12.1 三段式波带

单一几何级数频谱（`wLen *= 0.58` 一路衰减 + 所有层同等方向扰动）的问题：
最长波也带 ±80° 的方向离散，主导方向被打散，海面呈"被风吹皱的山脉"。
修正为 CPU 侧显式构建三段波带，作为 uniform 数组上传：

| 波带 | 层数 | 波长 | 方向离散 | 距离衰减权重 fade |
|------|------|------|----------|--------------------|
| macro swell | 3 | `swellWavelength × {1.0, 1.75, 0.8}`（约 200~600m） | ≤ ±10°（固定小偏角） | 0（直达地平线） |
| wind sea | 6 | `18 + windSpeed^1.45` 起 ×0.62 衰减 | ±10° → ±42° 随频率展宽 | 0.55 → 1.0 |
| chop | 3 | 7.5 / 4.8 / 3.1 m | ±50° | 1.0（仅近场） |

要点：

- **方向离散随频率增大**（真实方向谱的定性特征）：长波窄、短波宽，
  保证远观存在单一主导涌浪方向。
- **chop 几何占比砍至 0.35**，省下的细节在 fragment 里以两octave 噪声梯度
  扰动法线补回，且随相机距离 `smoothstep(420, 70, dist)` 收敛——远景不闪。
- **水平位移防穿插**：各层水平因子 Q = steepness，CPU 侧求和，
  超过 1.1 时整体等比缩小（`qScale = 1.1 / ΣQ`）。
- 每层数据打包：`waveA = (dir.x, dir.y, k, ω)`、
  `waveB = (amplitude, phase, fade, Q)`、`waveC = (sharp, _)`，每帧重建（12 层，CPU 开销可忽略）。

### 12.2 距离相关简化

物理 pass 内按 texel 到纹理中心的世界距离 r（网格跟随相机，中心 ≈ 相机）做两级衰减：

```glsl
float distFade = smoothstep(fadeStart, halfSize * 0.95, r);   // 按 fade 权重渐隐
float edgeCut  = smoothstep(halfSize * 0.8, halfSize * 0.95, r); // 非 swell 波带在网格边缘强制归零
float atten = 1.0 - distFade * fade;
if (fade > 0.0) atten *= 1.0 - edgeCut;
```

非 swell 波带在网格边缘归零后，外圈裙边网格（环形、径向指数分布顶点）只需
在 vertex shader 里求值同一组 swell 层（共享同一批 uniform Vector4 实例），
即可与主网格无缝衔接；剩余差异由与天空地平线色统一的指数雾遮蔽。

### 12.3 前倾浪峰（相位扭曲）

尖峰波形 `shaped = (1 - |sin f|)^sharp` 本身前后对称。在求值波形前做相位扭曲：

```glsl
f -= skew * cos(f);
```

推导：相位对空间的导数 `dF/dx = k·(1 + skew·sin f)`。浪峰在 f ≈ 0 处，
**迎波面**（f > 0，sin f > 0）相位变化更快 → 波形被压缩 → 前坡陡；
**背波面**（f < 0）被拉伸 → 后坡缓。配合恢复的完整 Gerstner 水平位移
`xz += d · cos(f) · Q · a`（M1 时代曾砍半），浪峰显著前倾、迎面中空。
skew 取 0~1；>1 时相位映射非单调，波形出现自折叠，需避免。

Jacobian 泡沫源同步改为按波带加权的启发式：

```glsl
jacobianSum += Q * shaped * (0.35 + 0.65 * fade) * atten;
```

swell 单独不产生白沫（权重 0.35），白沫集中在 wind sea / chop 浪峰压缩处。

### 12.4 泡沫三级层级

泡沫仍存单通道累积值 F，按值域分段着色（threshold = 显示阈值 T）：

| 层级 | 判据 | 表现 |
|------|------|------|
| crest whitecap | `F > T` 或瞬时 `1 - jacobian > 0.5` | 锐利、近纯白，受朗伯光照 |
| trailing foam | `0.45T < F < T` | 半透拖尾，气泡噪声调制 |
| residual lacing | `0.05 < F < 0.45T` | 世界空间双 octave `1-|snoise|` 脉络纹理调制的残留花纹 |

### 12.5 风格化着色组合

```
finalColor = mix(waterRamp, skyReflection, fresnel * 0.55)
           + (wideSpec + glitter) * sunTint
finalColor = mix(finalColor, foamColor, foamHierarchy)
finalColor = mix(finalColor, horizonColor, 1 - exp(-dist * fogDensity * heightFactor))
```

- **waterRamp**：深/浅水色按 `浪高(0.75) + 掠射角(0.25)` 的风格化 ramp，非物理混合；
- **定向透光（主视觉）**：`pow(dot(view, -sun), 2.5) × 浪高薄度 × (1 - lambert)`，
  背光浪体透出可调 SSS 色；
- **宽幅高光**：指数从 128 降为可调（默认 40），叠加 `pow(spec, 240) × 噪声闪烁` 的 sun glitter；
- **大气统一**：雾色 = 天空地平线色 = 裙边远端色 = 清屏色，海天交界不可见；
  雾按 距离 × 高度（波谷略多）双因子。

---

## 13. 近岸浅水方程（SWE，M2）

近岸层用浅水方程高度场模拟冲滩回流与孤立水洼晃动，叠加在 L0 大洋涌浪之上。
求解器选 **虚拟管道模型（virtual pipe / Mei-St'ava）**——GPU 友好、天然守恒质量、
天然处理干湿格（干格水深为 0、不产生外流），且因外流被钳制在格内可用水量以内而恒非负。

### 13.1 共享地形场（单一事实来源）

海底高程是世界 XZ 的解析函数 `terrainHeight(p)`（`terrain.js` 的 `TERRAIN_GLSL`），
被注入海底网格 vertex shader（可视）与 SWE 求解器（床面），并在 CPU 侧镜像
（`terrainHeightJS`）用于初始化水深。三者共用同一场，渲染床面与模拟床面永不打架。

地形 = 远场深海（≈ −130m + fbm）在以原点为心的近岸圆盘内插值到岸滩剖面：
沿 +x 由海面以下抬升到陆地（海平面 = 世界 y=0），并在上滩面挖一个带凸缘的孤立潮池。

### 13.2 管道模型差分

状态用两张 GPGPU 纹理，每个子步乒乓一次：

```
textureFlux  = vec4(fE, fW, fN, fS)        // 到 4 邻格的外流体积率
textureWater = vec4(depth, vx, vz, surfaceY)
```

记格心水面 `H = b + d`（床面 b + 水深 d），格宽 L，重力 g，子步长 Δt：

```glsl
// 通量 pass：从上帧通量 + 当前水面梯度更新外流（钳到 ≥0）
fE = max(0, fE_prev * damp + Δt·g·L·(H_c - H_east));   // 其余方向同理
// 防止抽干：外流体积不超过格内可用水量
K = min(1, d·L² / ((fE+fW+fN+fS)·Δt));   fdir *= K;
```

```glsl
// 水深 pass：净通量更新水深（管道模型天然守恒）
inflow  = 西格.fE + 东格.fW + 南格.fN + 北格.fS;
outflow = fE + fW + fN + fS;
d_new   = max(0, d + Δt·(inflow - outflow) / L²);
```

速度（供泡沫/着色）由穿格净通量估计：`vx ≈ (东向净通量)/(L·d̄)`。
通量阻尼 `damp = exp(-drag·Δt)` 让水体最终归于静止。

### 13.3 CFL 与子步

显式积分需满足 `Δt < L / √(g·h_max)`。每帧把 `frameDt·timeScale` 切成 `substeps`
个子步，并钳上限（0.08s）。近岸活动带 h≲24m → c≈15m/s、L≈1.6m → CFL≈0.1s，
4 子步下 Δt≈0.003s 余量充足；深场格基本静止，不参与波动。

### 13.4 干湿格

水深 `d` 全程钳 `≥0`；干格 d=0 → 外流为 0（管道模型自动），水只会从有水的邻格流入。
沙滩上的水膜就是 `d≈ε` 的湿格，冲滩回流即由此涌现，无需特判。

### 13.5 边界耦合（单向，L0 → SWE）

域外缘 deep ring（`terrain < seaLevel − 4`、距边 ≤3 texel）做 **Dirichlet 强制**：
把 L0 位移纹理在该世界点的 `disp.y` 采进来，令 `d = max(0, (seaLevel + disp.y·coupling) − b)`，
把开阔海涌浪"推入"近岸。采样 L0 时世界点经 `(wp − gridOffset)/gridSize + 0.5` 映射到
跟随相机的位移纹理 UV；落在 [0,1] 外（相机远离近岸时）则退化为静止海平面。
非 deep 的边（陆侧/汀线）走 clamp-to-edge → 零梯度反射壁。

### 13.6 渲染整合

海面 mesh 在 vertex shader 里按域内距判定 mask（域心 1、边缘 0 平滑过渡）：

```glsl
y      = mix(seaLevel + dispL0.y, sweSurfaceY, mask);   // 高度切到 SWE 解
水平位移 = mix(L0 chop, 0, mask);                        // 近岸去掉尖峰横移
法线    = mix(L0 法线, SWE 面法线, mask);                // 由 surfaceY 邻格有限差分
```

干湿透明：`alpha *= mix(1, smoothstep(0.02, 0.3, depth), mask)`，水膜趋零时海面淡出
露出沙滩；`alpha < 0.02` 直接 discard 避免在沙滩上写深度。
泡沫并入同一张泡沫纹理：foam pass 由 `uv·gridSize + gridOffset` 还原世界点、映射到
SWE 域采样，按"快且浅"判破碎、按汀线水深带判 swash，加进 `generation`。

### 13.7 孤立水洼

潮池被高于海面的滩面与凸缘环绕，与外海不连通，初始化时给它一个倾斜水面
（lopsided fill）以其自身固有频率起振——因此可视地与外海涌浪**不同步**晃动，
低 drag 下持续可见；外海则由边界耦合持续推动，二者节奏明显不同。

---

## 14. 浪击粒子（飞溅，M3）

L0 涌浪撞击近岸礁石时抛出水花，落水留下泡沫痕迹。用 GPGPU 粒子池实现，
与高度场**单向耦合**（粒子采样 L0，不反作用于水面，除了装饰性泡沫 splat）。

### 14.1 粒子池（双纹理乒乓）

```
texturePosition = vec4(x, y, z, life)     世界位置 + 剩余寿命
textureVelocity = vec4(vx, vy, vz, seed)  速度 + 恒定身份种子
```

池大小 `res²`（默认 128² = 16384）。`life ≤ 0` 即死亡并停泊在屏外。
`seed` 在初始化时随机写入、终生不变，作为每个粒子去相关的随机身份。

### 14.2 障碍物（礁石）

CPU 维护礁石列表，打包成定长 `vec4` uniform 数组（centre.xz, 水线半径）。
GLSL ES 1.00 不能用动态下标索引数组，故用 **loop-select**（`for k { if(k==oi) ob = arr[k]; }`）
取出选中礁石——与多波叠加里用循环计数器索引 `uWaveA[i]` 同一手法。
场景里放对应的礁石 mesh（粗面锥体）作视觉对应物。

### 14.3 重生判定（关键：两个 pass 必须一致）

GPUComputationRenderer 同一 `compute()` 里 position/velocity 两个 pass 读的都是上帧纹理，
因此只要重生决策是 `(seed, uTime)` 的确定函数、两个 pass 注入**同一段 GLSL**，二者必然一致：

```glsl
bool spawn(seed, out pos, out vel, out life) {
    // 每帧伯努利试验；uBirthProb = clamp(birthRate · dt, 0, 1)
    if (hash11(seed·13.137 + uTime·53) > uBirthProb) return false;
    // 选礁石，方位偏向迎波面（-waveDir）± 展宽
    ang = atan(-waveDir.y, -waveDir.x) + (hash-0.5)·2.6;
    hitXZ = reef.xz + dir(ang) · reef.r;
    // 采 L0 该点波面高度，低于阈值（没有浪在拍）就不生
    strength = surfaceY(hitXZ) - seaLevel;
    if (strength < uSpawnThreshold) return false;
    // 出生：迎面外向 + 向上 + 抖动，能量随波高
    vel = (outward·horizBurst + up·vertBurst) · energy + jitter;
    pos = vec3(hitXZ.x, seaLevel + strength·0.6, hitXZ.y);
    life = uLife · (0.6 + 0.4·hash);
}
```

`surfaceY(worldXZ)` 把世界点经 `(wp − gridOffset)/gridSize + 0.5` 映射到跟随相机的 L0
位移纹理 UV，取 `seaLevel + disp.y`；落在 [0,1] 外退化为静止海平面。

### 14.4 运动与落水死亡

活粒子纯弹道：`vel.y -= g·dt; vel *= exp(-drag·dt); pos += vel·dt; life -= dt`。
当 `pos.y < surfaceY(pos.xz)`（落回水面）或寿命耗尽即死亡。无粒子间作用——便宜。

### 14.5 落水 splat 写回泡沫

活粒子靠近水面时，把一小撮泡沫 additive 渲染进共享泡沫纹理：
另起一个 Points + 正交相机，顶点把世界点映射到泡沫纹理 UV（`gl_Position = uv·2−1`），
权重 `clamp(1 − (y − seaLevel)/6, 0, 1)`（越贴水越强），在 `gpuCompute.compute()`**之后**
渲染进 `getCurrentRenderTarget(foam)`。该缓冲既是本帧海面采样源，又是下帧泡沫累积的
"上帧"输入，故 splat 随泡沫衰减自然淡出。渲染时 `autoClear=false` 并复位渲染目标。

### 14.6 billboard 渲染

Points 顶点按 `aRef`（每粒子的纹理 texel 坐标）采 position 纹理取世界位，
死粒子停泊到裁剪域外。`gl_PointSize` 按距离与寿命缩放，alpha 出生淡入、死亡淡出，
AdditiveBlending + 软圆点。

---

## 15. FFT 频谱海洋（M4，现行 L0）

> M4 起 L0 深海高度场由 Tessendorf FFT 频谱海洋生成（`sea/fft.js`），**取代**第 1、2、12 节
> 描述的尖峰 Gerstner 叠加。下游接口不变：仍产出一张跟随相机的位移纹理
> `(RGB = 世界位移 Dx/高度/Dz, A = Jacobian)`，故 L2/L3、海面网格、泡沫 pass 全部无感知。
> 第 1、2、12 节作为历史参考保留。

### 15.1 频域种子 h0(k)

Phillips 谱 × 高斯随机，每个 texel 一次（仅风/波高参数变化时重建）：

```
P(k) = A · exp(-1/(k·L)²) / k⁴ · |k̂·ŵ|^s(k)         L = V²/g（风浪尺度）
       · exp(-k² · ℓ²)                               米级涟漪截断（ℓ = rippleSuppress）
       · (k̂·ŵ < 0 ? 0.07 : 1)                        压制逆风波
s(k) = mix(swellSpread, 2, clamp(log2(max(kL·√2, 1))/4, 0, 1))
h0(k) = (1/√2)(ξ_r + iξ_i)·√P(k)                     ξ ~ N(0,1)，Box-Muller
```

频率布局：texel `m∈[0,N)` 对应波数 `n = m − N/2`，`k = 2π·n / patchSize`。
A 为内部常数（取 1），在 §15.4 的 RMS 归一里约掉，故其绝对值无关紧要。

**为什么不能用全频段统一的 cos² 展宽 + 次网格截断**：k⁻⁴ 谱的斜率谱 `k²P ∝ k⁻²`，
每个倍频程贡献近似恒定的斜率方差——法线（以及 cel shading 的硬分带）被网格能分辨的
最小波长统治，全场呈现同尺寸的均匀斑点。两个对策：
1. **频率相关方向展宽** `s(k)`：谱峰处（kL·√2 ≈ 1）取高指数（默认 6）→ 长峰线主导涌浪；
   峰上 4 个倍频程线性放宽到 2 → 短波散开成 chop。CPU 的 RMS 积分必须用同一公式。
2. **米级涟漪截断** `exp(-k²ℓ²)`：ℓ 取米级（默认 0.8 m）才真正衰减最高频段；
   原 `ℓ = L·0.001`（风速 22 时约 5 cm）在可分辨波段内形同虚设。
   被截掉的细节由 fragment shader 的风带状（wind-lane）噪声法线补回，
   并以低频 mask 调制成"成片出现、间隔玻璃带"，而非均匀地毯。

### 15.2 时间演化与位移谱

色散 `ω(k)=√(g|k|)`（深水）。每帧把 h0 推到当前时刻并组出三路位移谱：

```
h̃(k,t) = h0(k)·e^{iωt} + conj(h0(−k))·e^{−iωt}       高度谱（厄米→实场）
D̃x = −i (k̂.x) h̃ ,  D̃z = −i (k̂.y) h̃                  水平 choppy 位移谱
```

`h0(−k)` 由镜像 texel `(N−m) mod N` 取得。三路谱各自厄米，故逆变换得实场。
**打包**：一次复数 iFFT 出两路实场——`C_A = D̃x + i·D̃z`（实部→Dx，虚部→Dz），
`C_B = h̃`（实部→高度）。RGBA 一张图同时承载 `RG = C_A`、`BA = C_B`，butterfly 一并变换。

### 15.3 Butterfly-texture iFFT

预计算一张 `stages × N` 的 butterfly 查找纹理（FloatType），每个 `(stage, index)` 存
`(twiddle.re, twiddle.im, topIndex, bottomIndex)`，stage 0 折入 bit-reversal。
twiddle 取正号 `e^{+i2πk/N}` 即合成逆变换。每个 pass：

```glsl
bf = texelFetch(butterfly, ivec2(stage, dir==0 ? px.x : px.y), 0);
a = texelFetch(input, dir==0 ? ivec2(bf.z, px.y) : ivec2(px.x, bf.z), 0);
b = texelFetch(input, dir==0 ? ivec2(bf.w, px.y) : ivec2(px.x, bf.w), 0);
fieldA = a.rg + cmul(bf.xy, b.rg);   // 两路复数同时蝶形
fieldB = a.ba + cmul(bf.xy, b.ba);
```

先 `log2(N)` 个水平 pass 再 `log2(N)` 个垂直 pass，在两张 RGBA 半浮点纹理间乒乓。

### 15.4 解析（resolve）与 RMS 归一

butterfly 算的是**未归一**的逆和 `Σ_k X_k e^{+i2π(k·x)/N}`；中心化谱（DC 在 N/2）需补
符号 `(−1)^(px+py)`，**不做 1/N² 除法**（Tessendorf 约定振幅全在谱里）：

```
spatial(px) = (−1)^(px.x+px.y) · texelFetch(input, px).rgb     // (Dx, Dz, height)
```

由 Parseval，逆和场的 RMS ≈ `√(Σ|h̃|²)`，时间平均 `Σ|h̃|² ≈ ΣP(k)`。故在 CPU 上一次性
积分 `rms = √(Σ P(k))`（与 shader 同式），令 `heightScale = waveHeight / rms`，
则输出高度 RMS ≈ `waveHeight` 米——**与风速/patch/A 无关的可预测物理增益**。
Jacobian 由相邻 texel 的 choppy 位移差分得（tile 周期、可环绕取样）：

```
J = (1 + ∂Dx/∂x)(1 + ∂Dz/∂z) − (∂Dx/∂z)(∂Dz/∂x)        J<1 折叠→泡沫
```

输出 tile `(Dx·hc, height·hs, Dz·hc, J)`，`hs=heightScale`、`hc=hs·choppiness`。

### 15.5 平铺进相机 patch（保接口）

FFT tile 是物理边长 `patchSize` 的**周期**图。再一个 pass 按世界位置平铺，写进与旧 Gerstner
完全同格式的相机中心位移纹理：`worldPos=(uv−0.5)·gridSize+gridOffset`，
采 `tile[fract(worldPos/patchSize)]`（Repeat+Linear）。下游照旧按
`uv=(wp−gridOffset)/gridSize+0.5` 取样，毫无感知。远场裙边直接按世界位置采同一张 tile，
故与主网格在接缝处天然吻合（无需旧版的短波边缘淡出）。

### 15.6 工程注意

- 全部 pass 用 `RawShaderMaterial` + `GLSL3` 全屏квад，半浮点 RT（与 GPGPU 一致，免扩展），
  butterfly 查找纹理用 FloatType 保证索引精确。
- `patchSize` 决定能承载的最长波——单级 FFT 是周期的，过小会暴露重复；过大则高频在固定 N 下变粗。
  单级是 M4 的折中，多级 cascade（不同尺度叠加）留作后续。
- 仅风速/风向/波高/choppiness 变化才重建 h0；h0 由 `hash(texel)` 确定性生成，
  改波高/choppiness 不会让相位跳变（只缩放），改风速/风向才换海况。

---

## 16. 解析宏观涌浪（macro swell）

### 16.1 动机

单级 FFT tile 的物理边长 `patchSize`（现行 420 m）是它能承载的最长波；Phillips 谱在
峰值波长附近能量也有限。结果是海面只有「平面上的褶皱」——中小尺度浪形丰富，但整体
仍躺在一个静止平面上，缺少数百米尺度的整体起伏。

解法：在 FFT 场之下叠加一层**解析 Gerstner 宏观涌浪**——3 个波长远超 patch 的长波分量，
让整张「布」也运动起来，FFT 褶皱骑在涌浪背上。

### 16.2 分量构成

由一组主参数（amplitude / wavelength / direction / steepness）确定性派生 3 个分量，
避免单一正弦的「合成感」：

| 分量 | 波长比 | 振幅占比 | 方向偏移 | 相位偏移 |
|------|--------|---------|----------|----------|
| 0 | 1.00 | 0.588 | 0 | 0 |
| 1 | 0.62 | 0.265 | +0.42 rad | 2.1 |
| 2 | 0.41 | 0.147 | −0.31 rad | 4.4 |

振幅占比和为 1，故 `swellAmplitude` 即合成浪峰的米制高度。每个分量按深水色散
`ω=√(gk)` 独立行进：

```glsl
f = dot(d, xz) * k - sqrt(g * k) * t + phase
disp.y  += A * sin(f)
disp.xz += d * Q * A * cos(f)          // 趋向浪峰的水平漂移（trochoid）
jac     -= Q * A * k * sin(f)          // Jacobian 迹项，浪峰处为负
```

steepness 预算均分到 3 个分量：`Q = steep / (3·k·A)`，保证 `Σ Q·k·A = steep ≤ 1`，
合成 trochoid 永不自交。

### 16.2b 风力增益与潮汐

FFT 与涌浪共用同一风力增益 `gain = clamp((U/22)², 0.12, 4.0)`（完全成长海的
`Hs ∝ U²` 关系）：`waveHeight` / `swellAmplitude` 标定在参考风速 22 m/s，
风加大则整个海况（含宏观涌浪）按风速平方抬升——修复了旧 RMS 锁定归一下
「风越大、能量挪向更长更平的波、海面反而显小」的问题。下限 clamp 防微风把海面压成镜面。

潮汐是纯时间函数（现实潮汐由天文周期决定）：`tide = A·sin(2πt/T)`，CPU 算好后作为
uniform 加进 `macroSwell` 的垂直位移。走位移纹理通道意味着 SWE 深水边界耦合同样
看到水位变化——涨潮自动淹滩、退潮自动回流，无需另写近岸逻辑。

### 16.3 注入点与接缝

涌浪在 **patch resolve**（fft.js 把周期 tile 平铺进相机中心位移纹理的那个 pass）按世界
坐标求值并加进 RGB（位移）与 A（Jacobian 增量）。位移纹理是全管线的唯一接口，因此：

- 主网格顶点位移与差分法线自动包含涌浪；
- 泡沫 pass 的帧间速度差分与 Jacobian 生成自动包含涌浪；
- SWE 深水边界耦合把涌浪推进近岸；
- 浪击粒子在涌浪峰顶更易触发。

远场裙边不走位移纹理，而是在顶点 shader 里调用**同一段 GLSL**（`SWELL_GLSL`，从 fft.js
导出）按世界坐标解析求值，与 tile 采样相加——与 resolve pass 完全同式，接缝不会张开。

着色参考振幅同步上调：`ampNorm = waveHeight·2.5 + swellAmplitude`，否则色带在每个
涌浪峰上饱和。

---

## 17. 参考视频运动对标层（M4.7）

目标是把现有混合海洋调成参考视频里“低频大运动主导、高频细节局部装饰”的节奏。
此阶段不改变 L0/L2/L3 的外部接口，只在各层内部增加更可信的驱动项。

### 17.1 低频 FFT cascade

单个 420 m FFT tile 容易显出周期，并且远海缺少宽峰慢起伏。新增一个低频 cascade：

```
mainTile  = FFT(N, 420 m)      // 中短浪
longTile  = FFT(128, 1400 m)   // 慢速长浪
disp      = main.rgb + long.rgb * longWaveStrength + macroSwell.rgb
J         = main.J + (long.J - 1) * longWaveStrength + macroSwell.J
```

`longWaveSpeedScale < 1` 只作用于低频 cascade 的演化时间，让大水体运动更重。
macro swell 保留为确定性主涌浪补充，但默认振幅下调，避免单一正弦支配画面。

### 17.2 泡沫生命周期

泡沫生成从“只看 Jacobian”升级为三条件门控：

```
fold      = smoothstep(threshold, threshold - 0.35, J)
crestGate = smoothstep(..., height / ampNorm)
slopeGate = smoothstep(..., |∇height|)
source    = fold * crestGate * slopeGate
```

累积泡沫继续按水平位移差分做平流，`foamStreak` 控制拖尾强度。显示时拆成：

- 即时白帽：当前压缩浪峰的硬边 crescent；
- 拖尾泡沫：平流后的累积纹理；
- 残留 lacing：Worley 细胞边界打碎的网状泡沫。

### 17.3 SWE 方向性边界耦合

浅水层深水 ring 不再四边同强度强制水位，而是按边界内法线与入射浪向加权：

```
incoming = smoothstep(-0.15, 0.75, dot(waveDir, inwardNormal))
boundary = ring * mix(0.18, 1.0, incoming)
```

边界同时注入 L0 水位和水平速度：

```
forcedDepth = max(0, seaLevel + disp.y * coupling - bed)
waveVel = (disp.xz - prevDisp.xz) / dt + waveDir * max(disp.y, 0) * 0.35
```

这样近岸浪线从迎浪侧成组推进，背浪边只保留弱开放边界，回流由管道模型自然产生。

### 17.4 撞击式 spray

浪击粒子重生由三条件决定：

```
height      = surface.y - seaLevel
impact      = dot(surfaceVelocity, -reefNormal)
compression = 1 - Jacobian
spawn if height > threshold && impact > eps && compression > eps
```

出生速度使用入射水平速度关于礁石法线的反射方向，再叠加向上速度与少量随机扰动：

```
v0 = normalise(reflect(waveVel, reefNormal) + reefNormal * burstBias) * burst
   + up * verticalBurst
```

因此水花只在真正迎浪撞击礁石时增强，而不是单纯随浪高随机喷发。

### 17.5 岛屿地形与材质分层

旧近岸地形是 cross-shore 方形 patch，俯视时会读成同深度的矩形浅水块。现行地形改为
以有噪声扰动的椭圆 SDF 表示岛屿：

```
sd = length((p - islandCentre) / islandRadius) - 1 + boundaryNoise
height = deepOcean -> reefShelf -> wetBeach -> inland
```

深度随 `sd` 分带渐进，并叠加沿岸沙坝、冲沟和小尺度起伏；SWE 与渲染仍采同一个
`terrainHeight`。海底 fragment shader 不再只按 slope 混沙/石，而是按高度、坡度和噪声混合
湿沙、干沙、硬土、软土、岩石与植被，让水线、沙滩、内陆和陡坡都有不同材质。

---

## 附录：数学常数

| 常数 | 值 | 说明 |
|-----|-----|------|
| g | 9.8 m/s² | 重力加速度 |
| π | 3.14159265359 | 圆周率 |
| 海水密度 | 1025 kg/m³ | 物理模拟参考 |

---

*本文档算法独立于具体渲染引擎，可在 WebGL/Unity/Unreal/自定义渲染器中实现。*

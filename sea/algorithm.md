# 实时海洋波形生成算法参考

本文档提炼了实时海洋渲染中的核心算法，可作为其他项目的独立参考实现。

---

## 1. 核心波形算法：绝对尖峰 Gerstner 波

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

## 附录：数学常数

| 常数 | 值 | 说明 |
|-----|-----|------|
| g | 9.8 m/s² | 重力加速度 |
| π | 3.14159265359 | 圆周率 |
| 海水密度 | 1025 kg/m³ | 物理模拟参考 |

---

*本文档算法独立于具体渲染引擎，可在 WebGL/Unity/Unreal/自定义渲染器中实现。*

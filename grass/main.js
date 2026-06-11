// --- Configuration ---
const CONFIG = {
    maxGrassHeight: 0.6, // 60cm
    terrainSize: 10,     // Default size 10x10 units
    segments: 256,       // Geometry segments for detail
};

// --- State ---
const state = {
    moveForward: false,
    moveBackward: false,
    moveLeft: false,
    moveRight: false,
    lastTime: performance.now(),
};

// --- Scene Setup ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87CEEB); // Sky blue background
scene.fog = new THREE.Fog(0x87CEEB, 10, 100);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 5, 10);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

// --- Lighting ---
// Natural ambient light (Hemisphere)
const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6);
hemiLight.position.set(0, 20, 0);
scene.add(hemiLight);

// Directional light (Sun)
const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
dirLight.position.set(10, 20, 10);
dirLight.castShadow = true;
dirLight.shadow.mapSize.width = 2048;
dirLight.shadow.mapSize.height = 2048;
dirLight.shadow.camera.near = 0.5;
dirLight.shadow.camera.far = 50;
const d = 15;
dirLight.shadow.camera.left = -d;
dirLight.shadow.camera.right = d;
dirLight.shadow.camera.top = d;
dirLight.shadow.camera.bottom = -d;
scene.add(dirLight);

// --- Terrain & Grass ---
let groundMesh, grassMesh;
let flowers = []; // Store flower objects for wind animation

// Ground Material (Earthy color)
const groundMaterial = new THREE.MeshStandardMaterial({
    color: 0x5d5345, // Earthy brown/grey
    roughness: 0.9,
    metalness: 0.1,
    vertexColors: true, // Enable vertex colors for height-based variation
});

// Wind Uniforms
const windUniforms = {
    uTime: { value: 0 },
    uWindForce: { value: 1.0 }, // 0 to 12
    uWindDirection: { value: new THREE.Vector2(1, 0) }, // Direction vector
};

// Grass Material with Custom Shader for Wind
const grassMaterial = new THREE.MeshStandardMaterial({
    color: 0x4ade80,
    roughness: 0.8,
    metalness: 0.1,
    side: THREE.DoubleSide,
    vertexColors: true, // Enable vertex colors for gradient
});

const windShaderLogic = (shader) => {
    shader.uniforms.uTime = windUniforms.uTime;
    shader.uniforms.uWindForce = windUniforms.uWindForce;
    shader.uniforms.uWindDirection = windUniforms.uWindDirection;

    // Inject uniforms and utility functions into <common> chunk (safest place)
    shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `
        #include <common>
        uniform float uTime;
        uniform float uWindForce;
        uniform vec2 uWindDirection;
        
        // Instance colors
        attribute vec3 instanceBaseColor;
        attribute vec3 instanceTipColor;
        
        // Varying for fragment shader
        varying vec3 vGrassColor;
        vec3 applyWind(vec3 position, vec3 worldPos, float grassHeight, mat4 instanceMatrix) {
            // 1. EXTRACT INSTANCE ROTATION COLUMNS
            // Normalize columns to get basis vectors (removing scale)
            vec3 instanceRight = normalize(instanceMatrix[0].xyz);
            vec3 instanceForward = normalize(instanceMatrix[2].xyz);
            
            // 2. PROJECT WIND INTO LOCAL SPACE
            // We need the effective wind direction relative to this specific blade's orientation
            vec2 localWindDir;
            localWindDir.x = dot(uWindDirection, instanceRight.xz);
            localWindDir.y = dot(uWindDirection, instanceForward.xz); // y in 2D is z in 3D
            localWindDir = normalize(localWindDir);
            
            // 3. PHYSICAL SCALING
            // Scale Y to match true world dimensions for correct aspect ratio bending
            vec3 p = position;
            p.y *= grassHeight; 
            
            // 4. CALCULATE DEFORMATION
            
            // Height factor (stiffness)
            float heightFactor = pow(smoothstep(0.0, 1.0, position.y), 2.0);
            
            // Compute force
            float force = uWindForce; // Base force 
            float attenuation = mix(1.0, 0.1, grassHeight / 0.6);
            force *= attenuation;
            
            // Wave
            float wave1 = sin(uTime * 3.0 + worldPos.x * 0.5 + worldPos.z * 0.5);
            float wave2 = sin(uTime * 7.0 + worldPos.x * 2.0 + worldPos.z * 2.0) * 0.2;
            float gust = sin(uTime * 0.7 + worldPos.x * 0.1 + worldPos.z * 0.2) * 0.05 + 1.0;
            float totalWave = (wave1 + wave2) * gust;
            float bendFactor = (totalWave * 0.5 + 0.5);
            
            // Bend angle
            float maxBend = force * 0.5 * bendFactor; 
            maxBend = clamp(maxBend, -1.0, 1.5);
            float angle = maxBend * pow(position.y, 2.0);
            
            // Rotation Axis in LOCAL space (perpendicular to local wind)
            vec3 axis = normalize(cross(vec3(0.0, 1.0, 0.0), vec3(localWindDir.x, 0.0, localWindDir.y)));
            
            // Construct Rotation Matrix
            float c = cos(angle);
            float s = sin(angle);
            float t = 1.0 - c;
            float x = axis.x, y = axis.y, z = axis.z;
            mat3 rotMat = mat3(
                t*x*x + c,    t*x*y - z*s,  t*x*z + y*s,
                t*x*y + z*s,  t*y*y + c,    t*y*z - x*s,
                t*x*z - y*s,  t*y*z + x*s,  t*z*z + c
            );
            
            // Apply rotation to physical vector
            vec3 deformed = rotMat * p;
            
            // STRICT LENGTH PRESERVATION (on physical vector)
            float len = length(p);
            if (len > 0.0001) {
                 // Sinc approximation for arc-chord shortening
                float halfAngle = angle * 0.5;
                float chordFactor = 1.0;
                if (halfAngle > 0.001) chordFactor = sin(halfAngle) / halfAngle;
                else chordFactor = 1.0 - (halfAngle * halfAngle) / 6.0;
                
                deformed = normalize(deformed) * len * chordFactor;
            }
            
            // 5. UNDO Y SCALING
            // The pipeline will re-apply scale via instanceMatrix later, so we must pre-divide
            deformed.y /= grassHeight;
            
            vGrassColor = mix(instanceBaseColor, instanceTipColor, position.y);
            return deformed;
        }
        `
    );

    // Inject logic into main() to apply deformation
    shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `
        vec3 transformed = vec3( position );
        #ifdef USE_INSTANCING
            // In InstancedMesh, instanceMatrix attribute contains the transform.
            // We need world position for the wave phase to look continuous across the field.
            vec4 instanceWorldPos = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
            
            // Extract grass height from instance matrix Y scale
            // instanceMatrix column 1 (second column, index 1) contains Y-axis scaling
            float grassHeight = length(instanceMatrix[1].xyz);
            
            // Apply wind deformation with correct physical scaling and rotation awareness
            transformed = applyWind(transformed, instanceWorldPos.xyz, grassHeight, instanceMatrix);
        #else
            // Fallback for non-instanced mesh (e.g. single blade testing)
            transformed = applyWind(transformed, vec3(0.0), 1.0, mat4(1.0));
        #endif
        `
    );

    // Modify fragment shader to use grass color
    shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `
        #include <common>
        varying vec3 vGrassColor;
        `
    );

    shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `
        #include <color_fragment>
        // Override with gradient color
        diffuseColor.rgb = vGrassColor;
        `
    );
};

grassMaterial.onBeforeCompile = windShaderLogic;

// Create a custom depth material for shadows that also animates
const grassDepthMaterial = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
});

// Copy the same shader logic to depth material
grassDepthMaterial.onBeforeCompile = windShaderLogic;

// Grass Geometry (Segmented & Tapered Blade)
// Width: 0.015, Height: 1.0
// Segments: 1 width, 5 height (for bending)
const grassGeometry = new THREE.PlaneGeometry(0.015, 1, 1, 5);
grassGeometry.translate(0, 0.5, 0); // Pivot at bottom

// Taper the geometry (make top vertices width 0)
const posAttribute = grassGeometry.attributes.position;
const vertexCount = posAttribute.count;

for (let i = 0; i < vertexCount; i++) {
    const x = posAttribute.getX(i);
    const y = posAttribute.getY(i);
    
    // Taper factor: 1.0 at bottom (y=0), 0.0 at top (y=1)
    // After translate(0, 0.5, 0), Y is 0 to 1.
    // Linearly taper width
    let taper = 1.0 - y;
    if (y < 0.01) taper = 1.0; // Keep base wide
    
    // Taper X coordinate
    posAttribute.setX(i, x * taper);
}

grassGeometry.computeVertexNormals(); 

// --- Flower Geometry Creation Functions ---

// Random flower color (avoid green)
function randomFlowerColor() {
    const hues = [0, 30, 60, 300, 270, 200]; // Red, Orange, Yellow, Magenta, Purple, Blue
    const hue = hues[Math.floor(Math.random() * hues.length)];
    const saturation = 0.6 + Math.random() * 0.4;
    const lightness = 0.5 + Math.random() * 0.2;
    return new THREE.Color().setHSL(hue / 360, saturation, lightness);
}

// Create petal geometry
function createPetalGeometry() {
    const geo = new THREE.PlaneGeometry(0.02, 0.04, 1, 3);
    const positions = geo.attributes.position;
    
    for (let i = 0; i < positions.count; i++) {
        const x = positions.getX(i);
        const y = positions.getY(i);
        const scale = Math.sqrt(Math.max(0, 1 - (y / 0.02) ** 2));
        positions.setX(i, x * scale);
        positions.setZ(i, y * 0.3);
    }
    
    geo.computeVertexNormals();
    return geo;
}

// Create complete flower
function createFlower(petalCount, color, height) {
    const flower = new THREE.Group();
    
    // Stem
    const stemGeo = new THREE.CylinderGeometry(0.001, 0.001, height, 4);
    const stemMat = new THREE.MeshStandardMaterial({ color: 0x2d5016 });
    const stem = new THREE.Mesh(stemGeo, stemMat);
    stem.position.y = height / 2;
    flower.add(stem);
    
    // Leaves (1-3)
    const leafCount = 1 + Math.floor(Math.random() * 3);
    const leafGeo = new THREE.PlaneGeometry(0.015, 0.03);
    const leafMat = new THREE.MeshStandardMaterial({ 
        color: 0x4ade80, 
        side: THREE.DoubleSide 
    });
    
    for (let i = 0; i < leafCount; i++) {
        const leaf = new THREE.Mesh(leafGeo, leafMat);
        leaf.position.y = height * (0.3 + (i / leafCount) * 0.4);
        leaf.rotation.y = (i / leafCount) * Math.PI * 2;
        leaf.rotation.x = Math.PI / 2 + (Math.random() - 0.5) * 0.5;
        flower.add(leaf);
    }
    
    // Flower head
    const flowerHead = new THREE.Group();
    flowerHead.position.y = height;
    
    // Center
    const centerGeo = new THREE.SphereGeometry(0.008, 8, 8);
    const centerMat = new THREE.MeshStandardMaterial({ color: 0xffff00 });
    const center = new THREE.Mesh(centerGeo, centerMat);
    flowerHead.add(center);
    
    // Petals
    const petalGeo = createPetalGeometry();
    const petalMat = new THREE.MeshStandardMaterial({ 
        color: color, 
        side: THREE.DoubleSide,
        roughness: 0.6
    });
    
    for (let i = 0; i < petalCount; i++) {
        const petal = new THREE.Mesh(petalGeo, petalMat);
        const angle = (i / petalCount) * Math.PI * 2;
        petal.position.x = Math.cos(angle) * 0.015;
        petal.position.z = Math.sin(angle) * 0.015;
        petal.rotation.y = angle;
        petal.rotation.x = -Math.PI / 4;
        flowerHead.add(petal);
    }
    
    flower.add(flowerHead);
    flower.castShadow = true;
    flower.receiveShadow = true;
    
    return flower;
}

function createInitialTerrain() {
    if (groundMesh) scene.remove(groundMesh);
    if (grassMesh) scene.remove(grassMesh);

    // 1. Create Flat Ground
    const groundGeo = new THREE.PlaneGeometry(CONFIG.terrainSize, CONFIG.terrainSize);
    groundMesh = new THREE.Mesh(groundGeo, groundMaterial);
    groundMesh.rotation.x = -Math.PI / 2;
    groundMesh.receiveShadow = true;
    scene.add(groundMesh);

    // 2. Initial empty grass (or placeholder) - optional, maybe just wait for image.
    // For now, let's just leave the ground bare until image upload.
}

createInitialTerrain();

// --- Image Processing & Terrain Generation ---
const imageUpload = document.getElementById('image-upload');
const canvas = document.createElement('canvas'); // Offscreen canvas
const ctx = canvas.getContext('2d');

imageUpload.addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(event) {
        const img = new Image();
        img.onload = function() {
            generateGrassFromImage(img);
        };
        img.src = event.target.result;
    };
    reader.readAsDataURL(file);
});

function generateGrassFromImage(img) {
    // Clean up previous grass and flowers
    if (grassMesh) {
        scene.remove(grassMesh);
        grassMesh.dispose(); 
    }
    
    // Remove old flowers
    flowers.forEach(flower => scene.remove(flower));
    flowers = [];

    // Recreate ground with random undulation
    if (groundMesh) {
        scene.remove(groundMesh);
    }
    
    const groundGeo = new THREE.PlaneGeometry(
        CONFIG.terrainSize, 
        CONFIG.terrainSize, 
        128, // More segments for smoother undulation
        128
    );
    
    // Apply random displacement to vertices
    const positions = groundGeo.attributes.position;
    const seed = Math.random() * 1000; // Random seed for variation
    
    // Track min/max height for color mapping
    let minHeight = Infinity;
    let maxHeight = -Infinity;
    const heights = [];
    
    for (let i = 0; i < positions.count; i++) {
        const x = positions.getX(i);
        const z = positions.getY(i); // Y in geometry space = Z in world space
        
        // Simple noise using multiple sin waves (pseudo-Perlin)
        const noise1 = Math.sin(x * 0.5 + seed) * Math.cos(z * 0.5 + seed);
        const noise2 = Math.sin(x * 1.2 + seed * 2) * Math.cos(z * 1.2 + seed * 2) * 0.5;
        const noise3 = Math.sin(x * 2.5 + seed * 3) * Math.cos(z * 2.5 + seed * 3) * 0.25;
        
        const totalNoise = noise1 + noise2 + noise3;
        
        // Increased displacement: ±15cm (30cm total range)
        const displacement = totalNoise * 0.15;
        
        // Z in geometry = Y in world after rotation
        positions.setZ(i, displacement);
        
        heights[i] = displacement;
        minHeight = Math.min(minHeight, displacement);
        maxHeight = Math.max(maxHeight, displacement);
    }
    
    groundGeo.computeVertexNormals();
    groundMesh = new THREE.Mesh(groundGeo, groundMaterial);
    groundMesh.rotation.x = -Math.PI / 2;
    groundMesh.receiveShadow = true;
    scene.add(groundMesh);
    
    // Store reference to ground geometry for later coloring
    const groundPositions = positions;
    const groundHeights = heights;
    
    // Helper: Get terrain height at world position by sampling ground geometry
    function getTerrainHeight(x, z) {
        const halfSize = CONFIG.terrainSize / 2;
        const gridSize = 128; // Ground geo segments
        const cellSize = CONFIG.terrainSize / gridSize;
        
        // World to grid
        const gridX = Math.floor((x + halfSize) / cellSize);
        const gridZ = Math.floor((z + halfSize) / cellSize);
        
        // Clamp to valid range
        const gx = Math.max(0, Math.min(gridSize, gridX));
        const gz = Math.max(0, Math.min(gridSize, gridZ));
        
        const index = gz * (gridSize + 1) + gx;
        return groundHeights[index] || 0;
    }
    
    // Helper: Calculate terrain normal at position (finite difference)
    function getTerrainNormal(x, z) {
        const delta = 0.05; // 5cm sampling distance
        
        const hL = getTerrainHeight(x - delta, z);
        const hR = getTerrainHeight(x + delta, z);
        const hD = getTerrainHeight(x, z - delta);
        const hU = getTerrainHeight(x, z + delta);
        
        // Calculate gradients
        const dx = (hR - hL) / (2 * delta);
        const dz = (hU - hD) / (2 * delta);
        
        // Normal vector: (-dx, 1, -dz) normalized
        const normal = new THREE.Vector3(-dx, 1, -dz).normalize();
        return normal;
    }

    const segments = CONFIG.segments; // 256

    // Resize canvas to match our grid
    canvas.width = segments + 1;
    canvas.height = segments + 1;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    // Helper: Sample height from image at world position
    function sampleHeight(x, z) {
        const halfSize = CONFIG.terrainSize / 2;
        const step = CONFIG.terrainSize / segments;
        
        // World to pixel
        const i = Math.round((z + halfSize) / step);
        const j = Math.round((x + halfSize) / step);
        
        if (i < 0 || i > segments || j < 0 || j > segments) return 0;
        
        const pixelIndex = (i * (segments + 1) + j) * 4;
        const r = data[pixelIndex];
        const g = data[pixelIndex + 1];
        const b = data[pixelIndex + 2];
        const brightness = (r + g + b) / 3 / 255;
        
        let baseHeight = (1 - brightness) * CONFIG.maxGrassHeight;
        return baseHeight * (1 - Math.random() * 0.05);
    }

    // Generate cluster centers based on grayscale map
    // Cluster density is proportional to grass density (darker = more clusters)
    function generateClusterCenters() {
        const clusters = [];
        const halfSize = CONFIG.terrainSize / 2;
        const step = CONFIG.terrainSize / segments;
        
        // Sample the image at higher resolution for better distribution
        const clusterStep = Math.floor(segments / 32); // ~32x32 grid of sampling points
        
        for (let i = 0; i <= segments; i += clusterStep) {
            for (let j = 0; j <= segments; j += clusterStep) {
                const pixelIndex = (i * (segments + 1) + j) * 4;
                const r = data[pixelIndex];
                const g = data[pixelIndex + 1];
                const b = data[pixelIndex + 2];
                const brightness = (r + g + b) / 3 / 255;
                
                // Grass density: 1.0 (black) to 0.0 (white)
                const grassDensity = 1 - brightness;
                
                // Number of clusters in this cell: 0-3 based on density
                // Dark areas get multiple clusters, light areas get none
                const numClusters = Math.floor(grassDensity * 3 + Math.random());
                
                for (let k = 0; k < numClusters; k++) {
                    // Random position within the cell
                    const randomOffsetX = (Math.random() - 0.5) * step * clusterStep;
                    const randomOffsetZ = (Math.random() - 0.5) * step * clusterStep;
                    
                    const x = (j * step) - halfSize + randomOffsetX;
                    const z = (i * step) - halfSize + randomOffsetZ;
                    
                    // Store cluster with its local density
                    clusters.push({ x, z, density: grassDensity });
                }
            }
        }
        
        return clusters;
    }

    // Generate random position within irregular hexagon
    function randomHexagon(center, radius = 0.2) {
        // Use polar coordinates for uniform distribution
        const r = Math.sqrt(Math.random()) * radius;
        const angle = Math.random() * Math.PI * 2;
        
        // Add slight irregularity
        const irregularity = 0.8 + Math.random() * 0.4; // 0.8-1.2
        
        return {
            x: center.x + r * Math.cos(angle) * irregularity,
            z: center.z + r * Math.sin(angle) * irregularity
        };
    }

    // Generate grass blades
    const grassBlades = [];
    const clusters = generateClusterCenters();
    
    
    // Track grass count per cluster for ground coloring
    const clusterStats = new Map();
    clusters.forEach(center => {
        clusterStats.set(center, { grassCount: 0, flowerCount: 0 });
    });
    
    clusters.forEach(center => {
        // Blade count based on local density: 50-200 scaled by density
        const minBlades = 50;
        const maxBlades = 200;
        const bladesInCluster = Math.floor(minBlades + (maxBlades - minBlades) * center.density * (0.5 + Math.random() * 0.5));
        
        let actualGrassCount = 0;
        
        for (let i = 0; i < bladesInCluster; i++) {
            const pos = randomHexagon(center, 0.15);
            const height = sampleHeight(pos.x, pos.z);
            
            if (height > 0.01) {
                actualGrassCount++;
                // Generate colors for this blade
                // Base (green with ±5% variation)
                const baseVariation = 0.95 + Math.random() * 0.1;
                const baseColor = new THREE.Color(0x4ade80).multiplyScalar(baseVariation);
                
                // Tip (yellow-green with ±50% variation)
                const yellow = new THREE.Color(0xffff00);
                const green = new THREE.Color(0x4ade80);
                const tipBase = new THREE.Color().lerpColors(green, yellow, Math.random());
                const tipVariation = 0.5 + Math.random() * 1.0;
                const tipColor = tipBase.clone().multiplyScalar(tipVariation);
                
                grassBlades.push({
                    x: pos.x,
                    z: pos.z,
                    height: height,
                    rotation: {
                        y: Math.random() * Math.PI,
                        x: (Math.random() - 0.5) * 0.2,
                        z: (Math.random() - 0.5) * 0.2
                    },
                    baseColor: baseColor,
                    tipColor: tipColor
                });
            }
        }
        
        clusterStats.get(center).grassCount = actualGrassCount;
    });

    // Generate flowers for suitable clusters (grass height 10-25cm)
    clusters.forEach(center => {
        // Sample average grass height
        let totalHeight = 0;
        let samples = 0;
        
        for (let i = 0; i < 10; i++) {
            const testPos = randomHexagon(center, 0.15);
            const h = sampleHeight(testPos.x, testPos.z);
            if (h > 0.01) {
                totalHeight += h;
                samples++;
            }
        }
        
        const avgHeight = samples > 0 ? totalHeight / samples : 0;
        
        // Only spawn flowers in 10-25cm grass
        if (avgHeight >= 0.1 && avgHeight <= 0.25) {
            const spacing = 0.05 + Math.random() * 0.1; // 5-15cm
            const numFlowers = Math.floor((0.15 * 2) / spacing);
            
            const flowerPositions = [];
            for (let i = 0; i < numFlowers; i++) {
                let pos;
                let attempts = 0;
                let validPos = false;
                
                do {
                    pos = randomHexagon(center, 0.12);
                    validPos = true;
                    
                    // Check if position is within terrain bounds
                    const halfSize = CONFIG.terrainSize / 2;
                    if (Math.abs(pos.x) > halfSize || Math.abs(pos.z) > halfSize) {
                        validPos = false;
                        attempts++;
                        continue;
                    }
                    
                    for (const f of flowerPositions) {
                        const dist = Math.sqrt((pos.x - f.x) ** 2 + (pos.z - f.z) ** 2);
                        if (dist < spacing) {
                            validPos = false;
                            break;
                        }
                    }
                    
                    attempts++;
                } while (!validPos && attempts < 10);
                
                if (validPos) {
                    const flowerHeight = 0.1 + Math.random() * 0.25; // 10-35cm
                    const petalCount = 4 + Math.floor(Math.random() * 4); // 4-7
                    const color = randomFlowerColor();
                    
                    const flower = createFlower(petalCount, color, flowerHeight);
                    const terrainY = getTerrainHeight(pos.x, pos.z);
                    flower.position.set(pos.x, terrainY, pos.z);
                    scene.add(flower);
                    
                    // Store for wind animation
                    flowers.push(flower);
                    
                    flowerPositions.push({ x: pos.x, z: pos.z });
                    
                    // Track flower count
                    clusterStats.get(center).flowerCount++;
                }
            }
        }
    });

    // Create InstancedMesh
    const totalInstances = grassBlades.length;
    grassMesh = new THREE.InstancedMesh(grassGeometry, grassMaterial, totalInstances);
    grassMesh.receiveShadow = true;
    grassMesh.castShadow = true;
    grassMesh.customDepthMaterial = grassDepthMaterial;

    // Create instance color attributes
    const baseColors = new Float32Array(totalInstances * 3);
    const tipColors = new Float32Array(totalInstances * 3);

    const dummy = new THREE.Object3D();

    grassBlades.forEach((blade, index) => {
        // Get terrain height and normal at this position
        const terrainY = getTerrainHeight(blade.x, blade.z);
        const terrainNormal = getTerrainNormal(blade.x, blade.z);
        
        // Apply random tilt (85-95 degrees relative to ground)
        // Perturb normal by approx +/- 5 degrees
        // tan(5 deg) ~= 0.087. Range [-0.087, 0.087].
        // (Math.random() - 0.5) is [-0.5, 0.5]. Multiplier 0.174 gives range [-0.087, 0.087].
        const tiltFactor = 0.175;
        terrainNormal.x += (Math.random() - 0.5) * tiltFactor;
        terrainNormal.z += (Math.random() - 0.5) * tiltFactor;
        terrainNormal.normalize();
        
        // Position: follow terrain height
        dummy.position.set(blade.x, terrainY, blade.z);
        
        // Rotation: align to PERTURBED terrain normal
        // Calculate rotation to align up vector (0,1,0) with terrain normal
        const up = new THREE.Vector3(0, 1, 0);
        const quaternion = new THREE.Quaternion();
        quaternion.setFromUnitVectors(up, terrainNormal);
        
        // Apply base rotation from quaternion
        dummy.quaternion.copy(quaternion);
        
        // Add original random rotation around Y-axis (spin)
        dummy.rotateY(blade.rotation.y);
        
        // Scale
        dummy.scale.set(1, blade.height, 1);
        dummy.updateMatrix();
        grassMesh.setMatrixAt(index, dummy.matrix);
        
        // Set colors
        baseColors[index * 3] = blade.baseColor.r;
        baseColors[index * 3 + 1] = blade.baseColor.g;
        baseColors[index * 3 + 2] = blade.baseColor.b;
        
        tipColors[index * 3] = blade.tipColor.r;
        tipColors[index * 3 + 1] = blade.tipColor.g;
        tipColors[index * 3 + 2] = blade.tipColor.b;
    });

    // Add instance attributes
    grassGeometry.setAttribute('instanceBaseColor', new THREE.InstancedBufferAttribute(baseColors, 3));
    grassGeometry.setAttribute('instanceTipColor', new THREE.InstancedBufferAttribute(tipColors, 3));

    grassMesh.instanceMatrix.needsUpdate = true;
    scene.add(grassMesh);
    
    // Color ground based on altitude (8-level stepped)
    const groundColors = new Float32Array(groundPositions.count * 3);
    
    // Define 8 colors for altitude levels (darkest to lightest)
    const colorLevel1 = new THREE.Color(0x8B6F47); // Lowest - darkest brown
    const colorLevel2 = new THREE.Color(0xA0825A); // Interpolated
    const colorLevel3 = new THREE.Color(0xB59563); // Interpolated
    const colorLevel4 = new THREE.Color(0xD89763); // Original level 2
    const colorLevel5 = new THREE.Color(0xE0AB82); // Interpolated
    const colorLevel6 = new THREE.Color(0xE8C4A0); // Original level 3
    const colorLevel7 = new THREE.Color(0xF0D7BA); // Interpolated
    const colorLevel8 = new THREE.Color(0xf9f08b); // Highest - lightest (user specified)
    
    for (let i = 0; i < groundPositions.count; i++) {
        const height = groundHeights[i]; // Altitude relative to sea level 0
        
        // Quantize altitude to 8 discrete levels
        // Range is approximately -0.15 to +0.15 (±15cm)
        // Each level spans ~3.75cm
        let color;
        if (height < -0.13125) {
            color = colorLevel1; // Below -13.125cm
        } else if (height < -0.09375) {
            color = colorLevel2; // -13.125 to -9.375cm
        } else if (height < -0.05625) {
            color = colorLevel3; // -9.375 to -5.625cm
        } else if (height < -0.01875) {
            color = colorLevel4; // -5.625 to -1.875cm
        } else if (height < 0.01875) {
            color = colorLevel5; // -1.875 to +1.875cm
        } else if (height < 0.05625) {
            color = colorLevel6; // +1.875 to +5.625cm
        } else if (height < 0.09375) {
            color = colorLevel7; // +5.625 to +9.375cm
        } else {
            color = colorLevel8; // Above +9.375cm
        }
        
        groundColors[i * 3] = color.r;
        groundColors[i * 3 + 1] = color.g;
        groundColors[i * 3 + 2] = color.b;
    }
    
    groundGeo.setAttribute('color', new THREE.BufferAttribute(groundColors, 3));
    groundGeo.attributes.color.needsUpdate = true;
}

// --- Controls ---
const controls = new THREE.OrbitControls(camera, renderer.domElement);

// "Mouse wheel adjusts distance between camera and ground: closest 1 m, furthest 100 m"
controls.minDistance = 1;
controls.maxDistance = 100;

// "Hold right mouse button and move to rotate the view"
// OrbitControls defaults: LEFT is ROTATE, RIGHT is PAN.
// We need RIGHT for ROTATE.
controls.mouseButtons = {
    LEFT: null, // Disable default left click
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: THREE.MOUSE.ROTATE
};

// "Allow users to use arrow keys or WASD to pan the view"
controls.enablePan = false; // Disable built-in random panning, we will implement custom WASD
// Actually, WASD usually moves the camera position relative to look direction (First Person style)
// Or does it pan the 'target' of OrbitControls?
// "Pan the view" suggests panning the camera.
// Standard OrbitControls panning moves the target. Let's move the camera & target together.

function onKeyDown(event) {
    switch (event.code) {
        case 'ArrowUp':
        case 'KeyW':
            state.moveForward = true;
            break;
        case 'ArrowLeft':
        case 'KeyA':
            state.moveLeft = true;
            break;
        case 'ArrowDown':
        case 'KeyS':
            state.moveBackward = true;
            break;
        case 'ArrowRight':
        case 'KeyD':
            state.moveRight = true;
            break;
    }
}

function onKeyUp(event) {
    switch (event.code) {
        case 'ArrowUp':
        case 'KeyW':
            state.moveForward = false;
            break;
        case 'ArrowLeft':
        case 'KeyA':
            state.moveLeft = false;
            break;
        case 'ArrowDown':
        case 'KeyS':
            state.moveBackward = false;
            break;
        case 'ArrowRight':
        case 'KeyD':
            state.moveRight = false;
            break;
    }
}

document.addEventListener('keydown', onKeyDown);
document.addEventListener('keyup', onKeyUp);

// --- UI Controls for Wind ---
const windForceInput = document.getElementById('wind-force');
const windForceVal = document.getElementById('wind-force-val');
const windAngleInput = document.getElementById('wind-angle');
const windAngleVal = document.getElementById('wind-angle-val');

// --- Wind Simulation Logic ---
class WindSystem {
    constructor() {
        this.baseForce = 1.0;
        this.baseAngle = 0; // Degrees
        this.gusts = [];
        this.nextGustTimer = 0;
        this.currentForce = 0;
        this.currentPhase = 0;
    }

    update(delta) {
        // 1. Spawn New Gusts
        this.nextGustTimer -= delta;
        if (this.nextGustTimer <= 0) {
            this.spawnGust();
            // Random interval between gusts: 0.5s to 2.0s
            // "Next gust arrives before the previous one ends" → Interval < Duration
            // Duration is usually 2-4s. So interval 1-3s ensures overlap.
            this.nextGustTimer = 1.0 + Math.random() * 2.5; 
        }

        // 2. Process Gusts
        let totalForceVec = new THREE.Vector2(0, 0);
        let totalWeight = 0;
        
        // Remove finished gusts
        this.gusts = this.gusts.filter(g => g.life < g.duration);

        // Safety cap: max 10 concurrent gusts (prevent memory leak)
        if (this.gusts.length > 10) {
            this.gusts = this.gusts.slice(-10);
        }

        if (this.gusts.length === 0) {
            // Should rarely happen if interval < duration, but handled essentially as 0 wind
            // Or fallback to last known state?
            // Let's spawn immediately if empty.
            this.spawnGust();
        }

        for (let gust of this.gusts) {
            gust.life += delta;
            
            // Normalized progress 0 -> 1
            const t = gust.life / gust.duration;
            
            // Curve: Sine wave 0 -> 1 -> 0 (Bell curve-ish)
            // sin(t * PI)
            const weight = Math.sin(t * Math.PI);
            
            // Gust Vector
            const rad = gust.angle * (Math.PI / 180);
            const gustVec = new THREE.Vector2(Math.cos(rad), Math.sin(rad)).multiplyScalar(gust.peakForce);
            
            totalForceVec.add(gustVec.multiplyScalar(weight));
            totalWeight += weight;
        }

        // 3. Calculate Resultant Wind
        if (totalWeight > 0.001) {
            // Weighted Average Vector (with division-by-zero protection)
            const avgVec = totalForceVec.divideScalar(Math.max(totalWeight, 0.001));
            
            // Calculate Force Magnitude
            // We want the peak force to be around the gust's peak force.
            // If weights sum to > 1, average is correct magnitude.
            this.currentForce = avgVec.length(); 
            
            // Update Uniform Direction
            // Normalize and cache (only update if direction changed significantly)
            if (this.currentForce > 0.001) {
                const dir = avgVec.clone().normalize();
                // Only update if direction changed > ~1 degree
                const currentDir = windUniforms.uWindDirection.value;
                const dotProduct = currentDir.dot(dir);
                // dot > 0.9998 means angle < ~1 degree
                if (dotProduct < 0.9998) {
                    windUniforms.uWindDirection.value.copy(dir);
                }
            }
        } else {
            this.currentForce = 0;
        }

        // 4. Update Phase (Movement of waves)
        // Wave speed depends on current force.
        const waveSpeed = 0.5 + this.currentForce * 0.2;
        this.currentPhase += delta * waveSpeed;

        // 5. Update Uniforms
        windUniforms.uTime.value = this.currentPhase;
        windUniforms.uWindForce.value = this.currentForce;
    }

    spawnGust() {
        // Duration: 2s to 5s
        const duration = 2.0 + Math.random() * 3.0;
        
        // Peer user request:
        // Angle: Base +/- 10 degrees
        const angleVariation = (Math.random() - 0.5) * 20; // -10 to 10
        const angle = this.baseAngle + angleVariation;
        
        // Force: Base +/- ?
        // User example: Base 2 -> 1.8, 2.1, 1.7, 1.9
        // Variation looks like +/- 10-15%? 
        // Let's say +/- 0.3 * Base (roughly) or specifically +/- 15%.
        const forceVariation = (Math.random() - 0.5) * 0.4 * this.baseForce; 
        const peakForce = Math.max(0, this.baseForce + forceVariation);

        this.gusts.push({
            life: 0,
            duration: duration,
            peakForce: peakForce,
            angle: angle
        });
    }
}

const windSystem = new WindSystem();

// UI Listeners update the system
windForceInput.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    windSystem.baseForce = val;
    windForceVal.textContent = val;
});

windAngleInput.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    windSystem.baseAngle = val;
    windAngleVal.textContent = val + '°';
});

// Initialize
windSystem.baseForce = 1.0;
windSystem.baseAngle = 0;
// Spawn initial gust immediately to avoid startup "dead wind" period
windSystem.spawnGust();
windSystem.nextGustTimer = 1.0 + Math.random() * 2.5;


// --- Animation Loop ---
function animate() {
    requestAnimationFrame(animate);

    const time = performance.now();
    const delta = (time - state.lastTime) / 1000; // seconds

    // Update Wind
    windSystem.update(delta);

    // Movement Logic
    // We want to move 'forward' relative to the camera's view (projected on XZ plane)
    const moveSpeed = 5 * delta; // units per second

    if (state.moveForward || state.moveBackward || state.moveLeft || state.moveRight) {
        // Get camera forward vector
        const forward = new THREE.Vector3();
        camera.getWorldDirection(forward);
        forward.y = 0; // Lock movement to ground plane
        forward.normalize();

        const right = new THREE.Vector3();
        right.crossVectors(forward, camera.up).normalize();

        const moveVec = new THREE.Vector3();

        if (state.moveForward) moveVec.add(forward);
        if (state.moveBackward) moveVec.sub(forward);
        if (state.moveLeft) moveVec.sub(right);
        if (state.moveRight) moveVec.add(right);

        moveVec.normalize().multiplyScalar(moveSpeed);

        camera.position.add(moveVec);
        controls.target.add(moveVec); // Move target with camera to keep looking at same relative point
        controls.update(); // Important whenever we change camera/target manually
    }

    // Animate flowers with wind (50% intensity of grass)
    if (flowers.length > 0) {
        const windDir = windUniforms.uWindDirection.value;
        const windForce = windUniforms.uWindForce.value * 0.5; // 50% of grass force
        const windTime = windUniforms.uTime.value;
        
        flowers.forEach(flower => {
            const pos = flower.position;
            
            // Wave based on position and time (similar to grass but simplified)
            const wave1 = Math.sin(windTime * 3.0 + pos.x * 0.5 + pos.z * 0.5);
            const wave2 = Math.sin(windTime * 7.0 + pos.x * 2.0 + pos.z * 2.0) * 0.2;
            const totalWave = wave1 + wave2;
            
            // Sway angle (rotation around Y-axis and tilt)
            const swayAngle = totalWave * windForce * 0.3; // Reduced multiplier for flowers
            
            // Apply rotation (flowers sway in wind direction)
            const windAngle = Math.atan2(windDir.y, windDir.x);
            flower.rotation.z = swayAngle * Math.cos(windAngle);
            flower.rotation.x = swayAngle * Math.sin(windAngle);
        });
    }

    state.lastTime = time;

    renderer.render(scene, camera);
}

// Handle resize
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

animate();

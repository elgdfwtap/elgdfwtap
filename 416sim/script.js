document.getElementById("fileInput").addEventListener("change", async e => {
  document.getElementById("superlabel").innerText="Loading dataset...";
  const file = e.target.files[0];
  if (!file) return;

  const dataset = await handleCSV(file);
  document.getElementById("superlabel").innerText="Finished Loading Dataset";
  populateFilters(dataset);

  // Build buckets for 0.1s increments
  const buckets = buildTimeBuckets(dataset, 0.1);
  const timeKeys = Array.from(buckets.keys()).sort((a,b) => a-b);
  dataset.computeSmoothedAcceleration();
  // Fit renderer to bounding box
  renderer.fitToDataset(dataset);
  renderer.setPointSize(5);
  // Set up playback controller
  const controller = new PlaybackController(timeKeys, { fps: 60 });

  // Listen for framechange events and draw that frame’s points
  window.addEventListener("framechange", (e) => {
    const { time } = e.detail;
    const indices = buckets.get(time);

    const filtered = indices.filter(idx => {
      const lane   = dataset.col5_int[idx];
      const vclass = dataset.col10_str[idx];
      const run    = dataset.col12_int[idx]; // run number column
      return (activeRun === null || run === activeRun) &&
         activeLanes.has(dataset.col5_int[idx]) &&
         activeClasses.has(dataset.col10_str[idx]);
    });

    renderer.drawPoints(dataset, filtered);
  });
  //set up analysis manager
  const analysisManager = new AnalysisManager(dataset, buckets);
  const staticAnalysisManager = new StaticAnalysisManager(dataset, buckets);
  document.getElementById("run-filter").addEventListener("change", () => {
    analysisManager.resetHistory();
  });
  // trigger once after load
  staticAnalysisManager.update();

  // toggle combined vs per-lane
  document.getElementById("density-mode-toggle").addEventListener("click", () => {
    staticAnalysisManager.mode.density =
      staticAnalysisManager.mode.density === "combined" ? "per-lane" : "combined";
    staticAnalysisManager.update();
  });

});



class Dataset {
  constructor(maxRows = 4_500_000) {
    this.col1_int   = new Int32Array(maxRows);
    this.col2_float = new Float32Array(maxRows);
    this.col3_float = new Float32Array(maxRows);
    this.col4_float = new Float32Array(maxRows);
    this.col5_int   = new Int32Array(maxRows);
    this.col6_float = new Float32Array(maxRows);
    this.col7_float = new Float32Array(maxRows);
    this.col8_float = new Float32Array(maxRows);
    this.col9_float = new Float32Array(maxRows);
    this.col10_str  = new Array(maxRows);
    this.col11_str  = new Array(maxRows);
    this.col12_int  = new Int32Array(maxRows);

    this.rowCount = 0;
    this.smoothedAcc = new Float32Array(maxRows);
  }

  addRow(row) {
    const i = this.rowCount++;
    this.col1_int[i]   = parseInt(row[0], 10);
    this.col2_float[i] = parseFloat(row[1]);
    this.col3_float[i] = parseFloat(row[2]);
    this.col4_float[i] = parseFloat(row[3]);
    this.col5_int[i]   = parseInt(row[4], 10);
    this.col6_float[i] = parseFloat(row[5]);
    this.col7_float[i] = parseFloat(row[6]);
    this.col8_float[i] = parseFloat(row[7]);
    this.col9_float[i] = parseFloat(row[8]);
    this.col10_str[i]  = row[9];
    this.col11_str[i]  = row[10];
    this.col12_int[i]  = parseInt(row[11], 10);
  }

  getBoundingBox() {
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < this.rowCount; i++) {
      const x = this.col3_float[i];
      const y = this.col4_float[i];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return { minX, maxX, minY, maxY };
  }

  getTimeRange() {
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < this.rowCount; i++) {
      const t = this.col2_float[i];
      if (t < min) min = t;
      if (t > max) max = t;
    }
    return { min, max };
  }

  getLaneNumbers(){
    const set = new Set();
    for (let i = 0; i < this.rowCount; i++) {
      set.add(this.col5_int[i]);
    }
    return Array.from(set).sort((a,b) => a-b);
  }
  getRunNumbers(){
    const set = new Set();
    for (let i = 0; i < this.rowCount; i++) {
      set.add(this.col12_int[i]);
    }
    return Array.from(set).sort((a,b) => a-b);
  }
  computeSmoothedAcceleration(windowSize = 20) {
    const trajectories = new Map(); // id -> array of {time, idx}

    // 1. Group by vehicle ID
    for (let i = 0; i < this.rowCount; i++) {
      const id = this.col1_int[i];
      if (!trajectories.has(id)) trajectories.set(id, []);
      trajectories.get(id).push({ time: this.col2_float[i], idx: i });
    }

    // 2. Sort each trajectory by time
    for (const arr of trajectories.values()) {
      arr.sort((a, b) => a.time - b.time);
    }

    // 3. Compute acceleration with central difference
    for (const arr of trajectories.values()) {
      const rawAcc = new Array(arr.length).fill(0);

      for (let j = 1; j < arr.length - 1; j++) {
        const vPrev = this.col6_float[arr[j - 1].idx];
        const vNext = this.col6_float[arr[j + 1].idx];
        const tPrev = arr[j - 1].time;
        const tNext = arr[j + 1].time;

        rawAcc[j] = (vNext - vPrev) / (tNext - tPrev);
      }

      // 4. Smooth with moving average
      const half = Math.floor(windowSize / 2);
      for (let j = 0; j < arr.length; j++) {
        let sum = 0, count = 0;
        for (let k = -half; k <= half; k++) {
          const n = j + k;
          if (n >= 0 && n < arr.length) {
            sum += rawAcc[n];
            count++;
          }
        }
        this.smoothedAcc[arr[j].idx] = sum / count;
      }
    }

    console.log("Smoothed acceleration computed.");
  }

}
function buildTimeBuckets(dataset, step = 0.1) {
    const buckets = new Map();

    for (let i = 0; i < dataset.rowCount; i++) {
      const t = dataset.col2_float[i];
      // Quantize to bucket key (avoid float drift with fixed decimal precision)
      const bucketKey = Math.round(t / step) * step;

      if (!buckets.has(bucketKey)) {
        buckets.set(bucketKey, []);
      }
      buckets.get(bucketKey).push(i); // store row index
    }

    return buckets;
}
// === CSV Handler with PapaParse ===
async function handleCSV(file) {
  return new Promise((resolve, reject) => {
    const dataset = new Dataset();

    Papa.parse(file, {
      worker: true,       // offload parsing to a web worker
      dynamicTyping: false,
      skipEmptyLines: true,
      step: (results, parser) => {
        const row = results.data;
        // Expect exactly 12 columns
        if (row.length === 12) {
          dataset.addRow(row);
        }
        // Optional: stop if rowCount exceeds maxRows
        if (dataset.rowCount >= dataset.col1_int.length) {
          parser.abort();
          console.warn("Dataset reached maximum allocated size");
        }
      },
      complete: () => {
        console.log("Parsing complete. Rows:", dataset.rowCount);

        // Example usage
        console.log("Bounding Box:", dataset.getBoundingBox());
        console.log("Time Range:", dataset.getTimeRange());
        console.log("Lane Numbers:", dataset.getLaneNumbers());

        resolve(dataset);
      },
      error: (err) => reject(err)
    });
  });
}



class PlaybackController {
  constructor(timeKeys, { fps = 60 } = {}) {
    this.timeKeys = timeKeys;   // sorted array of timestamps
    this.fps = fps;

    this.currentFrame = 0;
    this.isPlaying = false;
    this.lastFrameTime = 0;

    // Keep handy the min/max time for reference
    this.startTime = timeKeys[0];
    this.endTime   = timeKeys[timeKeys.length - 1];

    window.addEventListener("keydown", (e) => this._onKey(e));
  }

  get currentTime() {
    return this.timeKeys[this.currentFrame];
  }

  _onKey(e) {
    if (e.code === "Space") {
      this.togglePlay();
      e.preventDefault();
    } else if (!this.isPlaying && e.code === "ArrowRight") {
      this.stepForward();
      e.preventDefault();
    } else if (!this.isPlaying && e.code === "ArrowLeft") {
      this.stepBackward();
      e.preventDefault();
    }
  }

  togglePlay() {
    this.isPlaying = !this.isPlaying;
    if (this.isPlaying) {
      this.lastFrameTime = performance.now();
      requestAnimationFrame((t) => this._tick(t));
    }
  }

  stepForward() {
    this.currentFrame = Math.min(this.currentFrame + 1, this.timeKeys.length - 1);
    this._dispatchFrame();
  }

  stepBackward() {
    this.currentFrame = Math.max(this.currentFrame - 1, 0);
    this._dispatchFrame();
  }

  _tick(timestamp) {
    if (!this.isPlaying) return;

    const elapsed = timestamp - this.lastFrameTime;
    if (elapsed >= 1000 / this.fps) {
      this.lastFrameTime = timestamp;
      this.currentFrame++;
      if (this.currentFrame >= this.timeKeys.length) {
        this.currentFrame = 0; // loop back around
      }
      this._dispatchFrame();
    }
    requestAnimationFrame((t) => this._tick(t));
  }

  _dispatchFrame() {
    const event = new CustomEvent("framechange", {
      detail: {
        frame: this.currentFrame,
        time: this.currentTime,
        startTime: this.startTime,
        endTime: this.endTime
      }
    });
    window.dispatchEvent(event);
  }
}

// Global sets you can check inside framechange event
const activeLanes   = new Set();
const activeClasses = new Set();
let activeRun = null; // instead of Set

function populateFilters(dataset) {
  // Show filters container
  document.getElementById("analysis-filters").style.display = "block";

  // ===== Lane Filter =====
  const laneDiv = document.getElementById("lane-filter");
  laneDiv.innerHTML = "<p>Filter by lane:</p>";

  const laneSet = new Set();
  for (let i = 0; i < dataset.rowCount; i++) {
    laneSet.add(dataset.col5_int[i]);
  }
  const lanes = Array.from(laneSet).sort((a, b) => a - b);


  lanes.forEach(lane => {
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = lane;
    cb.checked = true;

    // initialize state
    activeLanes.add(lane);

    // listener
    cb.addEventListener("change", () => {
      if (cb.checked) activeLanes.add(lane);
      else activeLanes.delete(lane);
    });

    laneDiv.appendChild(cb);
    laneDiv.appendChild(document.createTextNode(" Lane " + lane));
  });

  // ===== Vehicle Class Filter =====
  const vehicleDiv = document.getElementById("vehicle-class-filter");
  vehicleDiv.innerHTML = "<p>Filter by vehicle class:</p>";

  const classSet = new Set();
  for (let i = 0; i < dataset.rowCount; i++) {
    classSet.add(dataset.col10_str[i]);
  }
  const classes = Array.from(classSet).sort();

  // Add "All"

  classes.forEach(vc => {
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = vc;
    cb.checked = true;

    // initialize state
    activeClasses.add(vc);

    cb.addEventListener("change", () => {
      if (cb.checked) activeClasses.add(vc);
      else activeClasses.delete(vc);
    });

    vehicleDiv.appendChild(cb);
    vehicleDiv.appendChild(document.createTextNode(" " + vc));
  });

  // ===== Run Filter =====
  const runDiv = document.getElementById("run-filter");
  runDiv.innerHTML = "<p>Filter by run:</p>";

  const runs = dataset.getRunNumbers ? dataset.getRunNumbers() : [];
  runs.sort((a, b) => a - b);


  runs.forEach(run => {
    const rb = document.createElement("input");
    rb.type = "radio";
    rb.value = run;
    rb.name = "run";
    
    rb.addEventListener("change", () => {
      if (rb.checked) {
        activeRun = run; // only one run at a time
      }
    });

    runDiv.appendChild(rb);
    runDiv.appendChild(document.createTextNode(" Run " + run));
  });
}



/* TODO
let sliderOne = document.getElementById("slider-1");
let sliderTwo = document.getElementById("slider-2");
let displayValOne = document.getElementById("range1");
let displayValTwo = document.getElementById("range2");
let minGap = 0;
let sliderTrack = document.querySelector(".slider-track");
let sliderMaxValue = document.getElementById("slider-1").max;
*/
function timeSortArray(data) {
  const groups = new Map();

  // Group rows by timestamp (col2_float = second column)
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const t = row["col2_float"]; // keep as string key to avoid float precision issues

    if (!groups.has(t)) {
      groups.set(t, []);
    }
    groups.get(t).push(row);
  }

  // Sort timestamps numerically
  const sortedKeys = Array.from(groups.keys()).sort((a, b) => parseFloat(a) - parseFloat(b));

  // Build final grouped array
  for (let i = 0; i < sortedKeys.length; i++) {
    timeSortedData.push(groups.get(sortedKeys[i]));
  }

  return timeSortedData;
}

function slideOne() {
  if (parseInt(sliderTwo.value) - parseInt(sliderOne.value) <= minGap) {
    sliderOne.value = parseInt(sliderTwo.value) - minGap;
  }
  displayValOne.textContent = sliderOne.value;
  fillColor();
}
function slideTwo() {
  if (parseInt(sliderTwo.value) - parseInt(sliderOne.value) <= minGap) {
    sliderTwo.value = parseInt(sliderOne.value) + minGap;
  }
  displayValTwo.textContent = sliderTwo.value;
  fillColor();
}


function resizeCanvasToDisplaySize(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const displayWidth  = Math.floor(canvas.clientWidth  * dpr);
  const displayHeight = Math.floor(canvas.clientHeight * dpr);
  if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
    canvas.width = displayWidth;
    canvas.height = displayHeight;
    return true;
  }
  return false;
}

function createShader(gl, type, source) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(info || 'Shader compile failed');
  }
  return sh;
}

function createProgram(gl, vsSrc, fsSrc) {
  const vs = createShader(gl, gl.VERTEX_SHADER,   vsSrc);
  const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(info || 'Program link failed');
  }
  return prog;
}

// 3x3 matrix multiply (A * B)
function mat3mul(a, b) {
  const r = new Float32Array(9);
  r[0] = a[0]*b[0] + a[3]*b[1] + a[6]*b[2];
  r[1] = a[1]*b[0] + a[4]*b[1] + a[7]*b[2];
  r[2] = a[2]*b[0] + a[5]*b[1] + a[8]*b[2];

  r[3] = a[0]*b[3] + a[3]*b[4] + a[6]*b[5];
  r[4] = a[1]*b[3] + a[4]*b[4] + a[7]*b[5];
  r[5] = a[2]*b[3] + a[5]*b[4] + a[8]*b[5];

  r[6] = a[0]*b[6] + a[3]*b[7] + a[6]*b[8];
  r[7] = a[1]*b[6] + a[4]*b[7] + a[7]*b[8];
  r[8] = a[2]*b[6] + a[5]*b[7] + a[8]*b[8];
  return r;
}

/**
 * Build a 3x3 transform that maps dataset coordinates -> pixel -> clip,
 * preserving aspect ratio and fitting entirely within the canvas.
 */
function computeDataToClipMatrix(bbox, canvasWidth, canvasHeight) {
  const { minX, maxX, minY, maxY } = bbox;
  const wData = Math.max(1e-12, maxX - minX);
  const hData = Math.max(1e-12, maxY - minY);

  // Uniform pixel scale to fit data into canvas (letterbox as needed)
  const s_px = Math.min(canvasWidth / wData, canvasHeight / hData);

  // Pixel-space offset to center the fitted data
  const x0 = (canvasWidth  - wData * s_px) * 0.5;
  const y0 = (canvasHeight - hData * s_px) * 0.5;

  // Data -> Pixel (affine)
  // x_px = s_px * x + (x0 - s_px * minX)
  // y_px = s_px * y + (y0 - s_px * minY)
  const dataToPixel = new Float32Array([
    s_px, 0,    0,
    0,    s_px, 0,
    x0 - s_px*minX, y0 - s_px*minY, 1
  ]);

  // Pixel -> Clip:
  // clipX = (x_px / (W/2)) - 1 = 2/W * x_px - 1
  // clipY = (y_px / (H/2)) - 1 = 2/H * y_px - 1
  const pxToClip = new Float32Array([
    2 / canvasWidth, 0,                0,
    0,               2 / canvasHeight, 0,
    -1,              -1,               1
  ]);

  // Full transform
  return mat3mul(pxToClip, dataToPixel);
}

class WebGLRenderer {
  constructor(canvas) {
    this.canvas = typeof canvas === 'string' ? document.querySelector(canvas) : canvas;
    this.gl = this.canvas.getContext('webgl') || this.canvas.getContext('experimental-webgl');
    if (!this.gl) throw new Error('WebGL not supported');

    const vs = `
attribute vec2 a_position;
attribute vec3 a_color;
attribute float a_pointSize;

uniform mat3 u_matrix;

varying vec3 v_color;

void main() {
  vec3 p = u_matrix * vec3(a_position, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  gl_PointSize = a_pointSize;   // per-point size
  v_color = a_color;
}

    `;
    const fs = `
precision mediump float;
varying vec3 v_color;
void main() {
  gl_FragColor = vec4(v_color, 1.0);
}
    `;
    this.program = createProgram(this.gl, vs, fs);
    this.uMatrix    = this.gl.getUniformLocation(this.program, 'u_matrix');
    this.uPointSize = this.gl.getUniformLocation(this.program, 'u_pointSize');

    this.posLoc   = this.gl.getAttribLocation(this.program, 'a_position');
    this.colorLoc = this.gl.getAttribLocation(this.program, 'a_color');

    this.posBuf   = this.gl.createBuffer();
    this.colorBuf = this.gl.createBuffer();

    this.pointSize = 2.0;
    this.colorScheme = (dataset, idx) => [1, 1, 1]; // default: white
    this.sizeScheme  = (dataset, idx, baseSize) => baseSize; // new
    this.pointSizeBuf = this.gl.createBuffer();
    this._idColorCache = new Map();//caches for stable random hues
    this._laneColorCache = new Map();

    this._resize();
    window.addEventListener('resize', () => {
      if (this._resize()) this._applyMatrix();
    });
    
  }
  
  // API methods
  setPointSize(size) {
    this.pointSize = size;
  }

  setColorScheme(fn) {
    // fn = (dataset, idx) => [r,g,b] in [0,1]
    this.colorScheme = fn;
  }
  setSizeScheme(fn) {
    // fn(dataset, idx, baseSize) => size
    this.sizeScheme = fn;
  }
  fitToDataset(dataset) {
    const bbox = dataset.getBoundingBox();
    this.matrix = computeDataToClipMatrix(bbox, this.canvas.width, this.canvas.height);
    this._applyMatrix();
  }

  _resize() {
    const changed = resizeCanvasToDisplaySize(this.canvas);
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    return changed;
  }

  _applyMatrix() {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniformMatrix3fv(this.uMatrix, false, this.matrix);
    gl.clearColor(0.08, 0.08, 0.1, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  clear() {
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }

  drawPoints(dataset, indices) {
    const gl = this.gl;
    if (!indices || indices.length === 0) {
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }

    const positions = new Float32Array(indices.length * 2);
    const colors    = new Float32Array(indices.length * 3);
    const sizes     = new Float32Array(indices.length);
    for (let i = 0; i < indices.length; i++) {
      const idx = indices[i];
      positions[2*i]   = dataset.col3_float[idx];
      positions[2*i+1] = dataset.col4_float[idx];
      const [r,g,b] = this.colorScheme(dataset, idx);
      colors[3*i]   = r;
      colors[3*i+1] = g;
      colors[3*i+2] = b;

      sizes[i] = this.sizeScheme(dataset, idx, this.pointSize);
    }


    // Upload position buffer
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(this.posLoc, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(this.posLoc);

    // Upload color buffer
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuf);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(this.colorLoc, 3, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(this.colorLoc);
    // Upload sizes
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointSizeBuf);
    gl.bufferData(gl.ARRAY_BUFFER, sizes, gl.DYNAMIC_DRAW);
    const sizeLoc = gl.getAttribLocation(this.program, 'a_pointSize');
    gl.vertexAttribPointer(sizeLoc, 1, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(sizeLoc);
    // Set uniforms
    gl.useProgram(this.program);
    gl.uniformMatrix3fv(this.uMatrix, false, this.matrix);
    gl.uniform1f(this.uPointSize, this.pointSize);

    // Draw
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.POINTS, 0, indices.length);
  }
  static hsv2rgb(h, s, v) {
    let c = v * s;
    let hp = h / 60;
    let x = c * (1 - Math.abs((hp % 2) - 1));
    let rgb;
    if (hp < 1) rgb = [c, x, 0];
    else if (hp < 2) rgb = [x, c, 0];
    else if (hp < 3) rgb = [0, c, x];
    else if (hp < 4) rgb = [0, x, c];
    else if (hp < 5) rgb = [x, 0, c];
    else rgb = [c, 0, x];
    let m = v - c;
    return [rgb[0] + m, rgb[1] + m, rgb[2] + m];
  }
}


const renderer = new WebGLRenderer('#gl');
function colorById(dataset, idx, renderer) {
  const id = dataset.col1_int[idx];
  if (!renderer._idColorCache.has(id)) {
    const hue = Math.random() * 360;
    renderer._idColorCache.set(id, WebGLRenderer.hsv2rgb(hue, 0.8, 0.9));
  }
  return renderer._idColorCache.get(id);
}

// 2. Color by Class (vehicle type)
function colorByClass(dataset, idx) {
  const vclass = dataset.col10_str[idx];
  const map = {
    "small-vehicle": [0.6,0.6,0.6],
    "large-vehicle": [0.2,0.5,0.2],
  };
  return map[vclass] || [1,1,1];
}

// 3. Color by Lane (stable random hue per lane)
function colorByLane(dataset, idx, renderer) {
  const lane = dataset.col5_int[idx];
  if (!renderer._laneColorCache.has(lane)) {
    const hue = Math.random() * 360;
    renderer._laneColorCache.set(lane, WebGLRenderer.hsv2rgb(hue, 0.7, 0.9));
  }
  return renderer._laneColorCache.get(lane);
}

// 4. Color by Speed (continuous gradient, e.g. blue -> green -> red)
function colorBySpeed(dataset, idx) {
  const speed = dataset.col6_float[idx];
  const maxSpeed = 40; // adjust to dataset
  const t = Math.min(speed / maxSpeed, 1.0); // normalize 0..1
  // interpolate: blue (0,0,1) -> green (0,1,0) -> red (1,0,0)
  if (t < 0.5) {
    const k = t / 0.5;
    return [0, k, 1-k]; // blue -> green
  } else {
    const k = (t-0.5)/0.5;
    return [k, 1-k, 0]; // green -> red
  }
}

// 5. Color by Braking
BRAKING_CUTOFF_VALUE = -0.5;
SPEED_CUTOFF_VALUE = 2;
function brakingColor(dataset, idx) {
  if (dataset.smoothedAcc[idx] < BRAKING_CUTOFF_VALUE || dataset.col6_float[idx] < SPEED_CUTOFF_VALUE) {
    color = [1.0, 0.0, 0.0]; // bright red, braking
  } else {  
    color = [0.48, 0.0, 0.0]; // dark red
  }
  return color;
}

function brakingSize(dataset, idx, baseSize) {
  const speed = dataset.col6_float[idx];
  const accel = dataset.col7_float[idx];
  if (speed <= 0 || accel <= BRAKING_CUTOFF_VALUE) {
    return baseSize * 1;
  }
  return baseSize;
}

document.getElementById("color-by-id").addEventListener("click", () => {
  renderer.setColorScheme((ds, idx) => colorById(ds, idx, renderer));
});

document.getElementById("color-by-class").addEventListener("click", () => {
  renderer.setColorScheme(colorByClass);
});

document.getElementById("color-by-lane").addEventListener("click", () => {
  renderer.setColorScheme((ds, idx) => colorByLane(ds, idx, renderer));
});

document.getElementById("color-by-speed").addEventListener("click", () => {
  renderer.setColorScheme(colorBySpeed);
});

document.getElementById("speed-mode-toggle").addEventListener("click", () => {
  analysisManager.mode.speed = 
    analysisManager.mode.speed === "combined" ? "per-lane" : "combined";
  analysisManager.refreshLineCharts();
});


const slider = document.getElementById("point-size-slider");
const sliderVal = document.getElementById("point-size-value");

slider.addEventListener("input", () => {
  const val = parseFloat(slider.value);
  sliderVal.textContent = val;
  renderer.setPointSize(val);
});

// Braking button
document.getElementById("color-by-braking").addEventListener("click", () => {
  renderer.setColorScheme(brakingColor);
  renderer.setSizeScheme(brakingSize);
});
const SPEED_PLOT_BUCKET_SIZE = 1.0;   // speed bins in m/s
const SPACING_PLOT_BUCKET_SIZE = 2.0; // spacing bins in meters
const SPEED_PLOT_MIN_HEIGHT = 40;   // y-axis minimum max
const SPACING_PLOT_MIN_HEIGHT = 70;
const SPEED_PLOT_MAX_X = 40;   // y-axis minimum max
const SPACING_PLOT_MAX_X = 50;

class AnalysisManager {
  constructor(dataset, buckets) {
    this.dataset = dataset;
    this.buckets = buckets;

    // charts
    this.charts = {
      speedHist:   makeHistChart("Speed Histogram",   document.querySelector("#speed-hist")),
      spacingHist: makeHistChart("Spacing Histogram", document.querySelector("#spacing-hist"), "rgba(0, 180, 80, 0.45)"),

      // line charts
      speedLine: this._makeLineChart("Space-Mean Speed (m/s)", "#space-mean-speed"),
      flowLine:  this._makeLineChart("Flow Rate (veh / frame)", "#flow-rate"),
    };

    // history buffers
    this.resetHistory();

    // viewing mode
    this.mode = { speed: "combined", flow: "combined" }; // or "per-lane"

    window.addEventListener("framechange", (e) => this.onFrame(e.detail));

    // when run selection changes (radio or UI signal), clear history
    document.getElementById("run-filter")?.addEventListener("change", () => {
      this.resetHistory();
      // also rebuild legends/series if you're in per-lane mode
      this._rebuildSeriesForCurrentMode();
    });
  }

  resetHistory() {
    this.history = {
      time: [],
      speed: [],      // combined
      flow: [],       // combined
      speedByLane: {},// lane -> array
      flowByLane:  {},// lane -> array
    };
  }

  _makeLineChart(title, selector) {
    const opts = {
      title, width: 640, height: 220,
      scales: { x: { time: false } }, // your X is "simulation time" numeric
      series: [
        {}, // x
        { label: "value", stroke: "steelblue" },
      ],
      axes: [
        { grid: { show: true }, label: "t" },
        { grid: { show: true } },
      ],
    };
    return new uPlot(opts, [[], []], document.querySelector(selector));
  }

  onFrame({ time }) {
    const indices = this.buckets.get(time);
    if (!indices || indices.length === 0) {
      // still advance X so line charts don't stall visually (optional)
      this._appendTimeOnly(time);
      return;
    }

    // apply filters
    const filtered = indices.filter(idx => {
      const lane   = this.dataset.col5_int[idx];
      const vclass = this.dataset.col10_str[idx];
      const run    = this.dataset.col12_int[idx];
      return activeLanes.has(lane) && activeClasses.has(vclass) && activeRun==(run);
    });

    // histograms
    this._updateSpeedHist(filtered);
    this._updateSpacingHist(filtered);

    // line series
    this._updateTimeSeries(time, filtered);
    this._refreshLineCharts();
  }

  _appendTimeOnly(t) {
    this.history.time.push(t);
    if (this.mode.speed === "combined") this.history.speed.push(null);
    if (this.mode.flow  === "combined") this.history.flow.push(null);
    Object.values(this.history.speedByLane).forEach(arr => arr.push(null));
    Object.values(this.history.flowByLane).forEach(arr  => arr.push(null));
    this._refreshLineCharts();
  }

  _updateSpeedHist(idxs) {
    const speeds = idxs.map(i => this.dataset.col6_float[i]);
    const { edges, counts } = binContinuous(speeds, SPEED_PLOT_BUCKET_SIZE, SPEED_PLOT_MAX_X);
    setHistogramData(this.charts.speedHist, edges, counts, SPEED_PLOT_BUCKET_SIZE, SPEED_PLOT_MIN_HEIGHT);
  }

  _updateSpacingHist(idxs) {
  const ds = this.dataset;

  // group indices by lane
  const laneGroups = new Map();
  for (const i of idxs) {
    const lane = ds.col5_int[i];
    if (!laneGroups.has(lane)) laneGroups.set(lane, []);
    laneGroups.get(lane).push(i);
  }

  // collect spacings across all lanes
  const spacings = [];
  for (const [lane, indices] of laneGroups) {
    // sort vehicles by x-position (col3_float assumed longitudinal)
    indices.sort((a, b) => ds.col3_float[a] - ds.col3_float[b]);

    for (let j = 1; j < indices.length; j++) {
      const prev = indices[j - 1];
      const curr = indices[j];
      const dx = ds.col3_float[curr] - ds.col3_float[prev];
      if (dx >= 0) spacings.push(dx);
    }
  }

  // bin into histogram
  const { edges, counts } = binContinuous(
    spacings,
    SPACING_PLOT_BUCKET_SIZE,
    SPACING_PLOT_MAX_X
  );

  setHistogramData(
    this.charts.spacingHist,
    edges,
    counts,
    SPACING_PLOT_BUCKET_SIZE,
    SPACING_PLOT_MIN_HEIGHT
  );
}


  _updateTimeSeries(time, idxs) {
    const lanes = new Set();
    let sumSpeed = 0;

    for (const i of idxs) {
      lanes.add(this.dataset.col5_int[i]);
      sumSpeed += this.dataset.col6_float[i];
    }

    const n = idxs.length || 1;
    const combinedSpeed = sumSpeed / n;
    const combinedFlow  = idxs.length; // vehicles per frame interval

    this.history.time.push(time);

    if (this.mode.speed === "combined")
      this.history.speed.push(combinedSpeed);

    if (this.mode.flow === "combined")
      this.history.flow.push(combinedFlow);

    // per-lane aggregation (mean speed & count by lane)
    const laneBuckets = {};
    for (const i of idxs) {
      const lane = this.dataset.col5_int[i];
      (laneBuckets[lane] ??= { n:0, sum:0 });
      laneBuckets[lane].n++;
      laneBuckets[lane].sum += this.dataset.col6_float[i];
    }

    for (const lane of Object.keys(laneBuckets)) {
      const { n, sum } = laneBuckets[lane];
      const mean = sum / (n || 1);

      if (!this.history.speedByLane[lane]) this.history.speedByLane[lane] = [];
      if (!this.history.flowByLane[lane])  this.history.flowByLane[lane]  = [];

      this.history.speedByLane[lane].push(mean);
      this.history.flowByLane[lane].push(n);
    }

    // pad missing lanes with null at this time to keep arrays aligned
    const allLaneKeys = new Set([
      ...Object.keys(this.history.speedByLane),
      ...Object.keys(this.history.flowByLane),
    ]);
    for (const lane of allLaneKeys) {
      if (!(lane in laneBuckets)) {
        this.history.speedByLane[lane]?.push(null);
        this.history.flowByLane[lane]?.push(null);
      }
    }
  }

  _rebuildSeriesForCurrentMode() {
    // rebuild speedLine series
    if (this.mode.speed === "combined") {
      this.charts.speedLine.setSeries([
        {}, { label: "Speed", stroke: "steelblue" },
      ]);
    } else {
      const laneKeys = Object.keys(this.history.speedByLane).sort((a,b)=>a-b);
      const series = [{ }];
      laneKeys.forEach((lane, idx) => {
        // simple deterministic color:
        const hue = (idx * 57) % 360;
        series.push({ label: `Lane ${lane}`, stroke: `hsl(${hue} 70% 45%)` });
      });
      this.charts.speedLine.setSeries(series);
    }

    // rebuild flowLine series
    if (this.mode.flow === "combined") {
      this.charts.flowLine.setSeries([
        {}, { label: "Flow", stroke: "tomato" },
      ]);
    } else {
      const laneKeys = Object.keys(this.history.flowByLane).sort((a,b)=>a-b);
      const series = [{ }];
      laneKeys.forEach((lane, idx) => {
        const hue = (idx * 57) % 360;
        series.push({ label: `Lane ${lane}`, stroke: `hsl(${hue} 70% 45%)` });
      });
      this.charts.flowLine.setSeries(series);
    }

    // refresh with current data
    this._refreshLineCharts();
  }

  _refreshLineCharts() {
    const t = this.history.time;

    if (this.mode.speed === "combined") {
      this.charts.speedLine.setData([t, this.history.speed]);
    } else {
      const laneKeys = Object.keys(this.history.speedByLane).sort((a,b)=>a-b);
      const series = [t, ...laneKeys.map(k => this.history.speedByLane[k])];
      this.charts.speedLine.setData(series);
    }

    if (this.mode.flow === "combined") {
      this.charts.flowLine.setData([t, this.history.flow]);
    } else {
      const laneKeys = Object.keys(this.history.flowByLane).sort((a,b)=>a-b);
      const series = [t, ...laneKeys.map(k => this.history.flowByLane[k])];
      this.charts.flowLine.setData(series);
    }
  }
}
// e.g., on a UI toggle
function setSpeedMode(mode) {           // "combined" | "per-lane"
  analysisManager.mode.speed = mode;
  analysisManager._rebuildSeriesForCurrentMode();
}
function setFlowMode(mode) {
  analysisManager.mode.flow = mode;
  analysisManager._rebuildSeriesForCurrentMode();
}



function makeBarsPaths(bucketSize) {
  // returns a uPlot paths() function for a bar series
  return (u, seriesIdx, idx0, idx1) => {
    const xs = u.data[0]; // left edges of bins
    const ys = u.data[seriesIdx]; // counts
    const y0px = u.valToPos(0, 'y', false);

    const fill = new Path2D();

    for (let i = idx0; i < idx1; i++) {
      const xLeftVal  = xs[i];
      const xRightVal = xLeftVal + bucketSize;

      const xL = u.valToPos(xLeftVal,  'x', true);
      const xR = u.valToPos(xRightVal, 'x', true);
      const yT = u.valToPos(ys[i] || 0, 'y', false);

      // guard
      if (!Number.isFinite(xL) || !Number.isFinite(xR) || !Number.isFinite(yT)) continue;

      fill.rect(xL, yT, Math.max(1, xR - xL), y0px - yT);
    }

    return {
      stroke: null, // no outline for bars (set Path2D if you want)
      fill,         // filled bars use series.fill style
      clip: null,
    };
  };
}
function binContinuous(values, bucketSize, maxX) {
  const numBins = Math.ceil(maxX / bucketSize);
  const counts  = new Array(numBins).fill(0);
  const edges   = new Array(numBins); // left edges

  for (let i = 0; i < numBins; i++) edges[i] = i * bucketSize;

  for (let v of values) {
    if (!Number.isFinite(v) || v < 0) continue;
    const bin = Math.min(Math.floor(v / bucketSize), numBins - 1);
    counts[bin]++;
  }

  return { edges, counts };
}

function makeHistChart(title, mountEl, barFillCss) {
  const opts = {
    title,
    width:  420,
    height: 220,
    scales: { x: { time: false }, y: { min: 0 } },
    series: [
      {}, // x-series (edges) - labels on axis
      {
        label: "count",
        points: { show: false },
        fill: barFillCss ?? "rgba(0, 120, 255, 0.45)",
        // stroke color is irrelevant since we return stroke:null in paths
        paths: null, // set at runtime with makeBarsPaths(bucketSize)
      },
    ],
    axes: [
      { grid: { show: true } },
      { label: "Count", grid: { show: true } },
    ],
  };

  return new uPlot(opts, [[], []], mountEl);
}

// after creating, set per-chart paths dynamically based on bucket size:
function setHistogramData(uplotInstance, edges, counts, bucketSize, minHeightFloor) {
  // ensure bars renderer
  uplotInstance.series[1].paths = makeBarsPaths(bucketSize);

  // fixed min-height (floor) to avoid jumpy Y scaling
  const yMax = Math.max(minHeightFloor, Math.max(0, ...counts));
  uplotInstance.setScale('y', { min: 0, max: yMax });

  // set data
  uplotInstance.setData([edges, counts]);
}
const HEADWAY_BIN_SIZE   = 0.5;   // seconds per bin
const HEADWAY_MAX_VALUE  = 10.0;  // max headway shown

const DENSITY_BIN_SIZE   = 20.0;  // meters per bin
class StaticAnalysisManager {
  constructor(dataset, buckets) {
    this.dataset = dataset;
    this.buckets = buckets;

    this.charts = {
      headwayHist: this._makeHistChart(
        "Average Headway Distribution",
        document.querySelector("#average-headway-hist"),
        "rgba(200,80,0,0.5)"
      ),
      densityRoad: this._makeLineChart(
        "Density Along Road",
        document.querySelector("#density-along-road")
      ),
    };

    this.mode = { density: "combined" }; // "combined" | "per-lane"

    // trigger update when filters or run change
    document.getElementById("lane-filter").addEventListener("change", () => this.update());
    document.getElementById("vehicle-class-filter").addEventListener("change", () => this.update());
    document.getElementById("run-filter").addEventListener("change", () => this.update());
  }

  // Chart factories
  _makeHistChart(title, mountEl, fillColor) {
    const opts = {
      title, width: 420, height: 220,
      scales: { x: { time: false }, y: { min: 0 } },
      series: [{}, { label: "Proportion", fill: fillColor, paths: null }],
      axes: [
        { label: "Headway (s)" },
        { label: "Proportion" },
      ],
    };
    return new uPlot(opts, [[], []], mountEl);
  }

  _makeLineChart(title, mountEl) {
    const opts = {
      title, width: 640, height: 240,
      scales: { x: { time: false } },
      series: [{}, { label: "Density", stroke: "steelblue" }],
      axes: [
        { label: "Position (x, m)" },
        { label: "Vehicles per bin" },
      ],
    };
    return new uPlot(opts, [[], []], mountEl);
  }

  // Public entrypoint
  update() {
    this.updateHeadwayHistogram();
    this.updateDensityAlongRoad();
  }

  // === Headway Histogram ===
  updateHeadwayHistogram() {
    const ds = this.dataset;

    // Group by lane -> times -> headways
    const headways = [];

    // Loop over all times (from buckets)
    for (const [time, idxs] of this.buckets.entries()) {
      // apply filters
      const filtered = idxs.filter(i =>
        activeLanes.has(ds.col5_int[i]) &&
        activeClasses.has(ds.col10_str[i]) &&
        activeRun==(ds.col12_int[i])
      );

      // group by lane
      const laneGroups = new Map();
      for (const i of filtered) {
        const lane = ds.col5_int[i];
        if (!laneGroups.has(lane)) laneGroups.set(lane, []);
        laneGroups.get(lane).push(i);
      }

      // compute headways = Δx / speed?
      // Here: time headway = spacing / speed
      for (const [lane, arr] of laneGroups) {
        arr.sort((a, b) => ds.col3_float[a] - ds.col3_float[b]); // by x

        for (let j = 1; j < arr.length; j++) {
          const prev = arr[j-1];
          const curr = arr[j];
          const dx = ds.col3_float[curr] - ds.col3_float[prev];
          const v  = ds.col6_float[curr];
          if (v > 0) {
            const hw = dx / v; // time headway
            if (hw > 0 && hw <= HEADWAY_MAX_VALUE) {
              headways.push(hw);
            }
          }
        }
      }
    }

    // bin headways
    const { edges, counts } = binContinuous(headways, HEADWAY_BIN_SIZE, HEADWAY_MAX_VALUE);

    // convert to proportions
    const total = headways.length || 1;
    const proportions = counts.map(c => c / total);

    setHistogramData(
      this.charts.headwayHist,
      edges,
      proportions,
      HEADWAY_BIN_SIZE,
      0.05 // y floor proportion
    );
  }

  // === Density Along Road ===
  updateDensityAlongRoad() {
    const ds = this.dataset;

    // collect all filtered indices across time
    const filtered = [];
    for (const [time, idxs] of this.buckets.entries()) {
      for (const i of idxs) {
        if (
          activeLanes.has(ds.col5_int[i]) &&
          activeClasses.has(ds.col10_str[i]) &&
          activeRun==(ds.col12_int[i])
        ) {
          filtered.push(i);
        }
      }
    }

    if (filtered.length === 0) return;

    let minX = Infinity, maxX = -Infinity;

    for (const i of filtered) {
      const x = ds.col3_float[i];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }

    const numBins = Math.ceil((maxX - minX) / DENSITY_BIN_SIZE);
    const edges = Array.from({ length: numBins }, (_, k) => minX + k * DENSITY_BIN_SIZE);

    if (this.mode.density === "combined") {
      // === Combined mode ===
      const counts = new Array(numBins).fill(0);
      for (const i of filtered) {
        const bin = Math.min(Math.floor((ds.col3_float[i] - minX) / DENSITY_BIN_SIZE), numBins - 1);
        counts[bin]++;
      }
      this.charts.densityRoad.setData([edges, counts]);
    } else {
      // === Per-lane mode ===
      const laneSet = [...new Set(filtered.map(i => ds.col5_int[i]))].sort((a,b)=>a-b);
      const allSeries = [edges];

      laneSet.forEach(lane => {
        const counts = new Array(numBins).fill(0);
        for (const i of filtered) {
          if (ds.col5_int[i] !== lane) continue;
          const bin = Math.min(Math.floor((ds.col3_float[i] - minX) / DENSITY_BIN_SIZE), numBins - 1);
          counts[bin]++;
        }
        allSeries.push(counts);
      });

      // 🚨 Important: only call setSeries when lane set changes
      const existingSeriesCount = this.charts.densityRoad.series.length - 1;
      if (existingSeriesCount !== laneSet.length) {
        const series = [{}];
        laneSet.forEach((lane, idx) => {
          const hue = (idx * 57) % 360;
          series.push({ label: `Lane ${lane}`, stroke: `hsl(${hue} 70% 45%)` });
        });
        this.charts.densityRoad.setSeries(series);
      }

      // Safe: this just updates the values, no recursion
      this.charts.densityRoad.setData(allSeries);
    }
  }

}
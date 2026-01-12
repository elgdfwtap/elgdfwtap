document.getElementById("fileInput").addEventListener("change", async e => {
  document.getElementById("superlabel").innerText="Loading dataset...";
  const file = e.target.files[0];
  if (!file) return;

  const dataset = await handleCSV(file);
  dataset.buildLaneGeometries({ minPoints: 2 });
  document.getElementById("superlabel").innerText="Finished Loading Dataset";
  populateFilters(dataset);
  activeRun = 6;
  
  // Build buckets for 0.1s increments
  const buckets = buildTimeBuckets(dataset, 0.1);
  const timeKeys = Array.from(buckets.keys()).sort((a,b) => a-b);
  dataset.computeSmoothedAcceleration();
  // Fit renderer to bounding box

  if (renderer.normalizeMode) {
    const stationBounds = dataset.getStationLaneBounds(activeRun);
    console.log("Station bounds", stationBounds);
  }
  const bbox = dataset.getBoundingBox();
  console.log("XY bounds", bbox);

  renderer.fitToDataset(dataset, activeRun, renderer.normalizeMode);
  renderer.setPointSize(5);
  renderer.drawLaneGeometries(dataset, activeRun);
  for (const runId in dataset.laneGeometry) {
    console.log("Lane geometry for run", runId, ":", dataset.laneGeometry[runId]);
    const matrix = buildStationOffsetMatrix(dataset.laneGeometry[runId]);
    console.log("Normalization matrix for run", runId, ":", matrix);
    renderer.setNormalizationMatrix(runId, matrix);
  }

  

  const controller = new PlaybackController(timeKeys, { fps: 30 });
  const pastFrames = [];
  
  //set up analysis manager
  const analysisManager = new AnalysisManager(dataset, buckets);
  const staticAnalysisManager = new StaticAnalysisManager(dataset, buckets);
  const seriesManager = new SeriesManager(document.getElementById("series-list"),dataset,activeRun,analysisManager);
  document.getElementById("add-series").addEventListener("click", () => {
    seriesManager.addSeries();
  });
  document.getElementById("run-filter").addEventListener("change", () => {
    seriesManager.reset(document.getElementById("series-list"),dataset,activeRun);
    analysisManager.resetHistory();
    analysisManager.prepareDensityBins();
  });
  analysisManager.prepareDensityBins();
  // trigger once after load
  staticAnalysisManager.update();
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
    

    renderer.drawPoints(dataset, filtered,activeRun);
    {
      pastFrames.push(indices);
      if (pastFrames.length > MAX_MA) pastFrames.shift();
      for (const cfg of seriesManager.getConfig()) {
        const metrics = calculateSeriesMetrics(cfg, indices, dataset, pastFrames);

        // Push into AnalysisManager scatter plot buffers
        analysisManager._updateScatterPlots(cfg.id, {
          flowDensity: [metrics.density, metrics.flow],
          speedDensity: [metrics.density, metrics.sms],
          speedFlow: [metrics.sms, metrics.flow],
        });

      }
    }
  });
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
    this.station     = new Float32Array(maxRows);
    // Store per (run,lane) line segments here:
    // laneGeometry[run][lane] = { x1, y1, x2, y2, slope, intercept, vertical, n }
    this.laneGeometry = Object.create(null);
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
  buildLaneGeometries({ minPoints = 2 } = {}) {
    // Accumulators per (run,lane)
    // key -> { n, sumX, sumY, sumXX, sumXY, minX, maxX, minY, maxY }
    const acc = new Map();

    const keyOf = (run, lane) => `${run}|${lane}`;

    // Single pass over rows
    for (let i = 0; i < this.rowCount; i++) {
      const run  = this.col12_int[i]; // run id (per your earlier usage)
      const lane = this.col5_int[i];  // lane number
      const x    = this.col3_float[i]; // longitudinal
      const y    = this.col4_float[i]; // lateral

      // Skip invalids early
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

      const k = keyOf(run, lane);
      let a = acc.get(k);
      if (!a) {
        a = {
          n: 0,
          sumX: 0, sumY: 0, sumXX: 0, sumXY: 0,
          minX:  Infinity, maxX: -Infinity,
          minY:  Infinity, maxY: -Infinity,
        };
        acc.set(k, a);
      }

      a.n += 1;
      a.sumX  += x;
      a.sumY  += y;
      a.sumXX += x * x;
      a.sumXY += x * y;

      if (x < a.minX) a.minX = x;
      if (x > a.maxX) a.maxX = x;
      if (y < a.minY) a.minY = y;
      if (y > a.maxY) a.maxY = y;
    }

    // Convert accumulators to trimmed segments
    // laneGeometry[run][lane] = { x1,y1,x2,y2,slope,intercept,vertical,n }
    this.laneGeometry = Object.create(null);

    for (const [k, a] of acc.entries()) {
      if (a.n < minPoints) continue; // ignore sparse groups

      const [runStr, laneStr] = k.split("|");
      const run  = parseInt(runStr, 10);
      const lane = parseInt(laneStr, 10);

      // Ordinary Least Squares: y = m x + b
      // m = (n*sumXY - sumX*sumY) / (n*sumXX - sumX^2)
      const denom = a.n * a.sumXX - a.sumX * a.sumX;

      let vertical = false;
      let m = 0, b = 0;

      if (Math.abs(denom) < 1e-12) {
        // Nearly vertical: best fit is x = x_bar
        vertical = true;
        const xBar = a.sumX / a.n;

        // Trim to y-bounds of the data
        const x1 = xBar, y1 = a.minY;
        const x2 = xBar, y2 = a.maxY;

        this._storeLaneGeometry(run, lane, {
          x1, y1, x2, y2,
          slope: Infinity,
          intercept: NaN,
          vertical,
          n: a.n
        });
      } else {
        m = (a.n * a.sumXY - a.sumX * a.sumY) / denom;
        b = (a.sumY - m * a.sumX) / a.n;

        // Trim to x-bounds of the data
        const x1 = a.minX;
        const y1 = m * x1 + b;
        const x2 = a.maxX;
        const y2 = m * x2 + b;

        this._storeLaneGeometry(run, lane, {
          x1, y1, x2, y2,
          slope: m,
          intercept: b,
          vertical,
          n: a.n
        });
      }
    }
  }

  _storeLaneGeometry(run, lane, seg) {
    if (!this.laneGeometry[run]) this.laneGeometry[run] = Object.create(null);
    this.laneGeometry[run][lane] = seg;
  }
  getStationLaneBounds(runId) {
    const geom = this.laneGeometry[runId];
    if (!geom) {
      return {minStation:0, maxStation:1, minLane:0, maxLane:1};
    }

    let minS = Infinity, maxS = -Infinity;
    let minL = Infinity, maxL = -Infinity;

    for (const laneId in geom) {
      const seg = geom[laneId];
      if (!seg) continue;
      if (!isFinite(seg.x1) || !isFinite(seg.x2)) {
        continue;
      }

      minS = Math.min(minS, seg.x1, seg.x2);
      maxS = Math.max(maxS, seg.x1, seg.x2);
      minL = Math.min(minL, +laneId);
      maxL = Math.max(maxL, +laneId);
    }


    if (!isFinite(minS) || !isFinite(maxS)) {
      return {minStation:0, maxStation:1, minLane:0, maxLane:1};
    }

    return {minStation:minS, maxStation:maxS, minLane:minL, maxLane:maxL};
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
  const a0 = a[0], a1 = a[1], a2 = a[2];
  const a3 = a[3], a4 = a[4], a5 = a[5];
  const a6 = a[6], a7 = a[7], a8 = a[8];

  const b0 = b[0], b1 = b[1], b2 = b[2];
  const b3 = b[3], b4 = b[4], b5 = b[5];
  const b6 = b[6], b7 = b[7], b8 = b[8];

  r[0] = b0*a0 + b1*a3 + b2*a6;
  r[1] = b0*a1 + b1*a4 + b2*a7;
  r[2] = b0*a2 + b1*a5 + b2*a8;

  r[3] = b3*a0 + b4*a3 + b5*a6;
  r[4] = b3*a1 + b4*a4 + b5*a7;
  r[5] = b3*a2 + b4*a5 + b5*a8;

  r[6] = b6*a0 + b7*a3 + b8*a6;
  r[7] = b6*a1 + b7*a4 + b8*a7;
  r[8] = b6*a2 + b7*a5 + b8*a8;

  return r;
}
/**
 * Build a 3x3 transform mapping dataset coords -> clip coords.
 * Fills the viewport so that:
 *   - station min -> left
 *   - station max -> right
 *   - lane min    -> top
 *   - lane max    -> bottom
 *
 * @param {Object} bbox {minStation, maxStation, minLane, maxLane}
 * @param {number} canvasWidth
 * @param {number} canvasHeight
 * @returns {Float32Array} 3x3 affine matrix
 */
function computeDataToClipMatrix(bbox, canvasWidth, canvasHeight) {
  const { minStation, maxStation, minLane, maxLane } = bbox;

  // avoid zero division
  const sRange = Math.max(1e-12, maxStation - minStation);
  const lRange = Math.max(1e-12, maxLane - minLane);

  // Scale factors: data -> normalized device coords [-1,+1]
  const sx = 2.0 / sRange;
  const sy = 2.0 / lRange;

  // Translation offsets so min maps to -1
  const tx = -1.0 - minStation * sx;
  // For lanes, invert axis so minLane is top (-1)
  const ty = +1.0 - minLane * sy;

  return new Float32Array([
    sx,  0,  0,
    0, -sy,  0,   // negative scale flips so top is smaller lane number
    tx,  ty,  1
  ]);
}
function computeStationOffsetToClipMatrix(range, canvasWidth, canvasHeight) {
  const { minStation, maxStation, minOffset = -1, maxOffset = 1 } = range;

  const sRange = Math.max(1e-12, maxStation - minStation);
  const oRange = Math.max(1e-12, maxOffset   - minOffset);

  const sx = 2.0 / sRange;   // station -> [-1, +1]
  const sy = 2.0 / oRange;   // offset  -> [-1, +1]

  const tx = -1.0 - minStation * sx;       // left  = minStation
  const ty = +1.0 - maxOffset  * sy;       // top   = maxOffset (flip Y)

  return new Float32Array([
    sx,  0,  0,
    0, -sy,  0,  // negative sy to put larger offset at top
    tx,  ty,  1
  ]);
}


function computeDataToClipMatrixXY(bbox, canvasWidth, canvasHeight) {
  const { minX, maxX, minY, maxY } = bbox;
  const wData = Math.max(1e-12, maxX - minX);
  const hData = Math.max(1e-12, maxY - minY);

  // scale factors to [-1,+1]
  const sx = 2.0 / wData;
  const sy = 2.0 / hData;

  const tx = -1.0 - minX * sx;
  const ty = -1.0 - minY * sy;

  return new Float32Array([
    sx,  0, 0,
    0,  sy, 0,
    tx,  ty, 1
  ]);
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
    
    this.normalizeMode = false;     // 🚩 render normalized or not
    this.normalizedMatrices = {};   // runId -> normalization mat3

    this._resize();
    window.addEventListener('resize', () => {
      if (this._resize()) this._applyMatrix();
    });
    
  }
  
  // API methods
  setNormalizeMode(flag) {
    this.normalizeMode = flag;
  }

  setNormalizationMatrix(runId, matrix) {
    this.normalizedMatrices[runId] = matrix;
  }
  
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
  fitToDataset(dataset, runId = null, normalized = false) {
    if (normalized && runId != null) {
      const bounds = dataset.getStationLaneBounds(runId);
      console.log("Using station bounds", bounds);
      this.clipMatrix = computeDataToClipMatrix(bounds, this.canvas.width, this.canvas.height);
    } else {
      const bbox = dataset.getBoundingBox();
      console.log("Using XY bounds", bbox);
      this.clipMatrix = computeDataToClipMatrixXY(bbox, this.canvas.width, this.canvas.height);
    }
    this._applyMatrix(runId);
  }



  _resize() {
    const changed = resizeCanvasToDisplaySize(this.canvas);
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    return changed;
  }

  _applyMatrix(runId = null) {
    const gl = this.gl;
    gl.useProgram(this.program);

    let mat = this.clipMatrix;

    if (this.normalizeMode && runId != null && this.normalizedMatrices[runId]) {
      // Final = clip(station/lane) * norm(XY->station/lane)
      mat = mat3mul(this.clipMatrix, this.normalizedMatrices[runId]);
    }

    this.matrix = mat; // keep for drawPoints
    gl.uniformMatrix3fv(this.uMatrix, false, mat);
    gl.clearColor(0.08, 0.08, 0.1, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }


  drawPoints(dataset, indices, runId) {
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
      const x = dataset.col3_float[idx];
      const y = dataset.col4_float[idx];

      positions[2*i]   = x;
      positions[2*i+1] = y;

      const [r,g,b] = this.colorScheme(dataset, idx);
      colors[3*i]   = r; colors[3*i+1] = g; colors[3*i+2] = b;

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

    // ===== Compute the CORRECT final matrix here (no reliance on fitToDataset/_applyMatrix)
    let finalMat;
    if (this.normalizeMode && runId != null && this.normalizedMatrices[runId]) {
      // station/offset clip-fit per run
      if (!this._clipSOByRun) this._clipSOByRun = Object.create(null);
      let clipSO = this._clipSOByRun[runId];
      if (!clipSO) {
        const soBounds = dataset.getStationLaneBounds(runId); // {minStation,maxStation,minLane,maxLane}
        // offset is normalized by the norm matrix to [-1,+1]
        clipSO = computeStationOffsetToClipMatrix(
          { minStation: soBounds.minStation, maxStation: soBounds.maxStation, minOffset: -1, maxOffset: 1 },
          this.canvas.width,
          this.canvas.height
        );
        this._clipSOByRun[runId] = clipSO;
      }
      // p_clip = clipSO * norm * p_xy
      finalMat = mat3mul(clipSO, this.normalizedMatrices[runId]);
    } else {
      // plain XY
      if (!this._clipXY) {
        const bbox = dataset.getBoundingBox();
        this._clipXY = computeDataToClipMatrixXY(bbox, this.canvas.width, this.canvas.height);
      }
      finalMat = this._clipXY;
    }

  
    // Use the final matrix
    gl.useProgram(this.program);
    gl.uniformMatrix3fv(this.uMatrix, false, finalMat);
    gl.uniform1f(this.uPointSize, this.pointSize);

    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.POINTS, 0, indices.length);
  }




  drawLaneGeometries(dataset, runId) {
  const gl = this.gl;
  gl.useProgram(this.program);

  // --- normal lane rendering (same as before) ---
  const verts = [];
  for (const runKey in dataset.laneGeometry) {
    const lanes = dataset.laneGeometry[runKey];
    for (const laneKey in lanes) {
      const seg = lanes[laneKey];
      if (!seg) continue;
      verts.push(seg.x1, seg.y1, seg.x2, seg.y2);
    }
  }
  if (verts.length === 0) return;

  const lineBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);

  const debugFS = `
    precision mediump float;
    void main() { gl_FragColor = vec4(0.0, 1.0, 0.0, 1.0); }
  `;
  const debugVS = `
    attribute vec2 a_position;
    uniform mat3 u_matrix;
    void main() {
      vec3 p = u_matrix * vec3(a_position, 1.0);
      gl_Position = vec4(p.xy, 0.0, 1.0);
    }
  `;
  const debugProg = createProgram(gl, debugVS, debugFS);
  const uMatLoc = gl.getUniformLocation(debugProg, "u_matrix");
  const posLoc  = gl.getAttribLocation(debugProg, "a_position");

  gl.useProgram(debugProg);
  gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
  gl.uniformMatrix3fv(uMatLoc, false, this.matrix);

  gl.lineWidth(2.0);
  gl.drawArrays(gl.LINES, 0, verts.length / 2);

  // --- DEBUG overlay: inverse corners polygon when not normalized ---
  // --- DEBUG overlay: inverse corners polygon when not normalized ---
if (!this.normalizeMode) {
  function mat3inv(m) {
      const a = m[0], b = m[1], c = m[2];
      const d = m[3], e = m[4], f = m[5];
      const g = m[6], h = m[7], i = m[8];
      const A = e*i - f*h, B = -(d*i - f*g), C = d*h - e*g;
      const D = -(b*i - c*h), E = a*i - c*g, F = -(a*h - b*g);
      const G = b*f - c*e, H = -(a*f - c*d), I = a*e - b*d;
      const det = a*A + b*B + c*C;
      if (Math.abs(det) < 1e-12) return mat3identity();
      const invDet = 1.0/det;
      return new Float32Array([
        A*invDet, D*invDet, G*invDet,
        B*invDet, E*invDet, H*invDet,
        C*invDet, F*invDet, I*invDet
      ]);
    }
  const invMat = mat3inv(this.matrix);

  // clip corners
  const corners = [
    [-1, -1],
    [ 1, -1],
    [ 1,  1],
    [-1,  1],
  ];

  // map back to dataset XY
  const vertsDbg = [];
  for (const [cx, cy] of corners) {
    const x = invMat[0]*cx + invMat[3]*cy + invMat[6];
    const y = invMat[1]*cx + invMat[4]*cy + invMat[7];
    vertsDbg.push(x, y);
  }
  // close loop
  vertsDbg.push(vertsDbg[0], vertsDbg[1]);

  // upload
  const dbgBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, dbgBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertsDbg), gl.STATIC_DRAW);

  // simple red program
  const redVS = `
    attribute vec2 a_position;
    uniform mat3 u_matrix;
    void main() {
      vec3 p = u_matrix * vec3(a_position, 1.0);
      gl_Position = vec4(p.xy, 0.0, 1.0);
    }
  `;
  const redFS = `
    precision mediump float;
    void main() { gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0); }
  `;
  const redProg = createProgram(gl, redVS, redFS);
  const uMatLoc = gl.getUniformLocation(redProg, "u_matrix");
  const posLoc  = gl.getAttribLocation(redProg, "a_position");

  gl.useProgram(redProg);
  gl.bindBuffer(gl.ARRAY_BUFFER, dbgBuf);
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

  // ⚠️ use identity here, not this.matrix
  gl.uniformMatrix3fv(uMatLoc, false, mat3identity());

  gl.lineWidth(2.0);
  gl.drawArrays(gl.LINE_STRIP, 0, vertsDbg.length / 2);

  gl.deleteBuffer(dbgBuf);
  gl.deleteProgram(redProg);

  console.log("Normalized box (dataset XY):", vertsDbg);
}


  gl.deleteBuffer(lineBuf);
  gl.deleteProgram(debugProg);
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

const SCATTER_BUFFER_SIZE = 1000;

class RollingBuffer {
  constructor(size = SCATTER_BUFFER_SIZE) {
    this.size = size;
    this.xs = new Float32Array(size);
    this.ys = new Float32Array(size);
    this.count = 0;   // number of valid points
    this.index = 0;   // next write position
  }

  push(x, y) {
    this.xs[this.index] = x;
    this.ys[this.index] = y;
    this.index = (this.index + 1) % this.size;
    if (this.count < this.size) this.count++;
  }

  getData() {
    // Return arrays in chronological order
    const dataXs = new Array(this.count);
    const dataYs = new Array(this.count);

    for (let i = 0; i < this.count; i++) {
      const idx = (this.index - this.count + i + this.size) % this.size;
      dataXs[i] = this.xs[idx];
      dataYs[i] = this.ys[idx];
    }
    return [dataXs, dataYs];
  }

  clear() {
    this.count = 0;
    this.index = 0;
  }
}

const MAX_MA = 100;
class AnalysisManager {
  constructor(dataset, buckets) {
    this.dataset = dataset;
    this.buckets = buckets;
    const baseSeriesDefs = [
      {}, // x-axis
      { label: "points", stroke: "steelblue", points: { show: true, size: 3 }, paths: null },
    ];
    // charts
    this.charts = {
      speedHist:   makeHistChart("Speed Histogram",   document.querySelector("#speed-hist")),
      spacingHist: makeHistChart("Spacing Histogram", document.querySelector("#spacing-hist"), "rgba(0, 180, 80, 0.45)"),

      // line charts
      speedLine: this._makeLineChart("Space-Mean Speed (m/s)", "#space-mean-speed"),
      flowLine:  this._makeLineChart("Flow Rate (veh / frame)", "#flow-rate"),

      densityRoad: this._makeLineChart("Density Along Road", "#density-along-road"),

      flowDensity: this._makeScatterPlot(
        "Flow vs Density",
        document.querySelector("#flow-density"),
        { x: { min: 0, max: 200 }, y: { min: 0, max: 2500 } },
        baseSeriesDefs,
        "Density",
        "Flow"
      ),

      speedDensity: this._makeScatterPlot(
        "Speed vs Density",
        document.querySelector("#speed-density"),
        { x: { min: 0, max: 20 }, y: { min: 0, max: 1 } },
        baseSeriesDefs,
        "Density",
        "Speed"
      ),

      speedFlow: this._makeScatterPlot(
        "Speed vs Flow",
        document.querySelector("#speed-flow"),
        { x: { min: 0, max: 0.1 }, y: { min: 0, max: 10 } },
        baseSeriesDefs,
        "Flow",
        "Speed"
      ),
    };
    this.scatterBuffers = new Map();
    this.seriesColors = new Map();   // seriesId -> color string
    // history buffers
    this.resetHistory();

    // viewing mode
    this.mode = { speed: "combined", flow: "combined" }; // or "per-lane"

    window.addEventListener("framechange", (e) => this.onFrame(e.detail));

    // when run selection changes (radio or UI signal), clear history
    document.getElementById("run-filter")?.addEventListener("change", () => {
      this.resetHistory();
      // also rebuild legends/series if you're in per-lane mode
      this.prepareDensityBins();
      renderer.fitToDataset(dataset, activeRun, renderer.normalizeMode);

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
  // When creating the scatter plot
_makeScatterPlot(title, mountEl, fixedScales, seriesDefs, xlabel = "X" , ylabel = "Y") {
  const opts = {
    title,
    width: 400,
    height: 300,
    scales: {
      x: { min: fixedScales.x.min, max: fixedScales.x.max, auto: false, time: false },
      y: { min: fixedScales.y.min, max: fixedScales.y.max, auto: false },
    },
    //series: seriesDefs,
    series:[ {}, { label: "points", stroke: "steelblue", paths: null, points: { show: true, size: 3 }, }, ],
    axes: [
      { label: xlabel, grid: { show: true } },
       { label: ylabel, grid: { show: true } },
    ],
  };

  return new uPlot(opts, [[], []], mountEl);
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
    this.updateDensityAlongRoad(filtered);
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
  _refreshScatterCharts() {
  // Build new series definition
  const seriesDefs = [{}]; // x-axis
  for (const [seriesId, color] of this.seriesColors.entries()) {
    seriesDefs.push({
      label: `Series ${seriesId}`,
      stroke: color,
      points: { show: true, size: 3, stroke: color },
      paths: null,
    });
  }
  seriesDefs.push({
    label: "Latest",
    stroke: "black",
    points: { show: true, size: 4, stroke: "black" },
    paths: null,
  });

  const scatterDefs = {
    flowDensity: { x: { min: 0, max: 0.2 }, y: { min: 0, max: 1.2 } },
    speedDensity: { x: { min: 0, max: 0.2 }, y: { min: 0, max: 20 } },
    speedFlow: { x: { min: 0, max: 30 }, y: { min: 0, max: 2 } },
  };

  for (const [chartName, scales] of Object.entries(scatterDefs)) {
    const mountEl = document.querySelector(`#${chartName.replace(/[A-Z]/g, m => "-" + m.toLowerCase())}`);
    // destroy old chart if present
    if (this.charts[chartName]) this.charts[chartName].destroy();
    // rebuild with new seriesDefs
    this.charts[chartName] = this._makeScatterPlot(chartName, mountEl, scales, seriesDefs);
  }
}


  _updateScatterPlots(seriesId, newPoints) {
    const buffers = this.scatterBuffers.get(seriesId);
    if (!buffers) return;

    // Push into buffers
    if (newPoints.flowDensity) {
      buffers.flowDensity.push(newPoints.flowDensity[0], newPoints.flowDensity[1]);
      const [xs, ys] = buffers.flowDensity.getData();
      this.charts.flowDensity.setData([xs, ys]);
    }

    if (newPoints.speedDensity) {
      buffers.speedDensity.push(newPoints.speedDensity[0], newPoints.speedDensity[1]);
      const [xs, ys] = buffers.speedDensity.getData();
      this.charts.speedDensity.setData([xs, ys]);
    }

    if (newPoints.speedFlow) {
      buffers.speedFlow.push(newPoints.speedFlow[0], newPoints.speedFlow[1]);
      const [xs, ys] = buffers.speedFlow.getData();
      this.charts.speedFlow.setData([xs, ys]);
    }
  }


  registerSeries(seriesId, color = null) {
  this.scatterBuffers.set(seriesId, {
    flowDensity: new RollingBuffer(),
    speedDensity: new RollingBuffer(),
    speedFlow: new RollingBuffer(),
  });
  this.seriesColors.set(seriesId, color || this._randomHue());
  this._refreshScatterCharts();
}

unregisterSeries(seriesId) {
  this.scatterBuffers.delete(seriesId);
  this.seriesColors.delete(seriesId);
  this._refreshScatterCharts();
}


  clearSeries(seriesId) {
    const buffers = this.scatterBuffers.get(seriesId);
    if (!buffers) return;
    for (const buf of Object.values(buffers)) buf.clear();
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
  updateScatterPlots(seriesId, newPoints) {
    console.log("updateScatterPlots called:", seriesId, newPoints);

    const buffers = this.scatterBuffers.get(seriesId);
    if (!buffers) return;
    console.log("FlowDensity push:", newPoints.flowDensity);
    console.log("SpeedDensity push:", newPoints.speedDensity);
    console.log("SpeedFlow push:", newPoints.speedFlow);

    // === Flow-Density ===
    if (newPoints.flowDensity) {
      buffers.flowDensity.push(newPoints.flowDensity.x, newPoints.flowDensity.y);
      const [xs, ys] = buffers.flowDensity.getData();
      this.charts.flowDensity.setData([xs, ys]);
    }

    // === Speed-Density ===
    if (newPoints.speedDensity) {
      buffers.speedDensity.push(newPoints.speedDensity.x, newPoints.speedDensity.y);
      const [xs, ys] = buffers.speedDensity.getData();
      this.charts.speedDensity.setData([xs, ys]);
    }
    
    // === Speed-Flow ===
    if (newPoints.speedFlow) {
      buffers.speedFlow.push(newPoints.speedFlow.x, newPoints.speedFlow.y);
      const [xs, ys] = buffers.speedFlow.getData();
      this.charts.speedFlow.setData([xs, ys]);
    }
    console.log("flowDensity setData:", [xs, ys]);

  }
  prepareDensityBins() {
    const ds = this.dataset;
    let minX = Infinity, maxX = -Infinity;

    // only use active run here (ignores time)
    for (let i = 0; i < ds.rowCount; i++) {
      if (activeRun === ds.col12_int[i]) {
        const x = ds.col3_float[i];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }

    const numBins = Math.ceil((maxX - minX) / DENSITY_BIN_SIZE);
    const edges = Array.from({ length: numBins }, (_, k) => minX + k * DENSITY_BIN_SIZE);

    this.densityInfo = { minX, maxX, numBins, edges };
  }
  updateDensityAlongRoad(idxs) {
    const ds = this.dataset;
    if (!this.densityInfo) return;   // must call prepareDensityBins first

    const { minX, numBins, edges } = this.densityInfo;

    // compute bin centers for plotting (guaranteed same length as counts)
    const centers = edges.map(e => e + DENSITY_BIN_SIZE / 2);

    // if no vehicles this frame, feed zeros to keep scales consistent
    if (!Array.isArray(idxs) || idxs.length === 0) {
      const emptyCounts = new Array(numBins).fill(20);
      this.charts.densityRoad.setData([centers, emptyCounts]);
      return;
    }


      // === Combined mode ===
      const counts = new Array(numBins).fill(0);

      for (const i of idxs) {
        if (
          activeLanes.has(ds.col5_int[i]) &&
          activeClasses.has(ds.col10_str[i]) &&
          activeRun === ds.col12_int[i]
        ) {
          const bin = Math.min(
            Math.floor((ds.col3_float[i] - minX) / DENSITY_BIN_SIZE),
            numBins - 1
          );
          counts[bin]++;
        }
      }
      //this.charts.densityRoad.setSeries([{}, { label: "Density", stroke: "green", fill: "rgba(0,180,80,0.3)" }]);
      this.charts.densityRoad.setData([centers, counts]);

  }
  _refreshLineCharts() { const t = this.history.time; if (this.mode.speed === "combined") { this.charts.speedLine.setData([t, this.history.speed]); } else { const laneKeys = Object.keys(this.history.speedByLane).sort((a,b)=>a-b); const series = [t, ...laneKeys.map(k => this.history.speedByLane[k])]; this.charts.speedLine.setData(series); } if (this.mode.flow === "combined") { this.charts.flowLine.setData([t, this.history.flow]); } else { const laneKeys = Object.keys(this.history.flowByLane).sort((a,b)=>a-b); const series = [t, ...laneKeys.map(k => this.history.flowByLane[k])]; this.charts.flowLine.setData(series); } }

}
  
// e.g., on a UI toggle


/**
 * Calculate metrics for one series at one frame (or averaged if MA > 1).
 */
function calculateSeriesMetrics(series, frameIndices, ds, pastFrames = []) {
  // Collect indices for current frame
  let points = frameIndices.filter(i => {
    const lane = ds.col5_int[i];
    const x = ds.col3_float[i];
    const accel = ds.smoothedAcc[i]; // already smoothed

    return (
      series.lanes.includes(lane) &&
      x >= series.start &&
      x <= series.end &&
      Math.abs(accel) <= series.accelCutoff
    );

  });

  // Add points from past frames if MA > 1
  if (series.MA > 1 && pastFrames.length > 0) {
    const merged = [];
    let count = 0;
    for (const f of pastFrames.slice(-series.MA)) {
      for (const i of f) {
        const lane = ds.col5_int[i];
        const x = ds.col3_float[i];
        const accel = ds.smoothedAcc[i];
        if (
          series.lanes.includes(lane) &&
          x >= series.start &&
          x <= series.end &&
          Math.abs(accel) <= series.accelCutoff
        ) {
          merged.push(i);
        }
      }
      count++;
    }
    if (merged.length > 0) {
      points = merged;
    }
  }

  const sms = computeSpaceMeanSpeed(points, ds);
  const density = computeDensity(points, ds);
  const flow = sms * density;

  return { sms, density, flow };
}


/**
 * Compute space mean speed.
 * SMS = N / Σ(1 / v_i) where v_i are vehicle speeds > 0
 */
function computeSpaceMeanSpeed(points, ds) {
  let denom = 0;
  let count = 0;
  for (const i of points) {
    const v = ds.col6_float[i];
    if (v > 0) {
      denom += 1 / v;
      count++;
    }
  }
  if (count === 0 || denom === 0) return 0;
  return count / denom;
}

/**
 * Compute density.
 * Count vehicles with valid spacing, then density = N / Σ(spacing_i)
 */
function computeDensity(points, ds) {
  // Group vehicles by lane for spacing
  const laneGroups = new Map();
  for (const i of points) {
    const lane = ds.col5_int[i];
    if (!laneGroups.has(lane)) laneGroups.set(lane, []);
    laneGroups.get(lane).push(i);
  }

  let totalVehicles = 0;
  let totalSpacing = 0;

  for (const [lane, idxs] of laneGroups.entries()) {
    // Sort by x position
    idxs.sort((a, b) => ds.col3_float[a] - ds.col3_float[b]);

    for (let j = 0; j < idxs.length - 1; j++) {
      const lead = idxs[j + 1];
      const follow = idxs[j];

      // spacing = x_lead - x_follow
      const spacing = ds.col3_float[lead] - ds.col3_float[follow];

      // Only count if spacing is positive
      if (spacing > 0) {
        totalVehicles++;
        totalSpacing += spacing;
      }
    }
  }

  if (totalVehicles === 0 || totalSpacing === 0) return 0;
  return totalVehicles / totalSpacing;
}

/**
 * Flow = density × space-mean speed
 */
function computeFlow(points, ds) {
  const sms = computeSpaceMeanSpeed(points, ds);
  const density = computeDensity(points, ds);
  return density * sms;
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

const DENSITY_BIN_SIZE   = 10.0;  // meters per bin
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
    };

    this.mode = { density: "combined" }; // "combined" | "per-lane"

    // trigger update when filters or run change
    document.getElementById("lane-filter").addEventListener("change", () => this.update());
    document.getElementById("vehicle-class-filter").addEventListener("change", () => this.update());
    document.getElementById("run-filter").addEventListener("change", () => {
      this.update();
    });

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

}
/**
 * Build a station/offset normalization matrix for a run.
 * @param {Object} laneGeoms - mapping laneId -> {x1,y1,x2,y2,...}
 * @returns {Float32Array} 3x3 affine transform matrix
 */
function buildStationOffsetMatrix(laneGeoms) {
  const laneIds = Object.keys(laneGeoms).map(k => parseInt(k, 10));
  if (laneIds.length < 1) return mat3identity();

  // --- 1. Outermost lanes
  const minLane = Math.min(...laneIds);
  const maxLane = Math.max(...laneIds);
  const outerLeft  = laneGeoms[minLane];
  const outerRight = laneGeoms[maxLane];

  // --- 2. Centerline vector
  const vL = [outerLeft.x2 - outerLeft.x1, outerLeft.y2 - outerLeft.y1];
  const vR = [outerRight.x2 - outerRight.x1, outerRight.y2 - outerRight.y1];
  const v  = normalize([ (vL[0]+vR[0])*0.5, (vL[1]+vR[1])*0.5 ]);

  // Perpendicular
  const n = [-v[1], v[0]];

  // --- 3. Origin = midpoint between outer lanes at start
  const p0 = [
    (outerLeft.x1 + outerRight.x1) * 0.5,
    (outerLeft.y1 + outerRight.y1) * 0.5,
  ];

  // --- 4. Compute raw offsets per lane
  const offsets = [];
  for (const laneId of laneIds) {
    const geom = laneGeoms[laneId];
    const cx = (geom.x1 + geom.x2) * 0.5;
    const cy = (geom.y1 + geom.y2) * 0.5;
    const rawOffset = dot([cx - p0[0], cy - p0[1]], n);
    offsets.push(rawOffset);
  }
  const minOff = Math.min(...offsets);
  const maxOff = Math.max(...offsets);

  const scale = 2.0 / (maxOff - minOff || 1);

  // --- 5. Assemble affine transform
  // Column 0 = station direction
  // Column 1 = scaled offset direction
  // Column 2 = translation
  const tx = -p0[0], ty = -p0[1];

  return new Float32Array([
    v[0],   n[0] * scale,   0,
    v[1],   n[1] * scale,   0,
    v[0]*tx + v[1]*ty,
    n[0]*scale*tx + n[1]*scale*ty,
    1
  ]);
}
class Series {
  constructor(id, lanes) {
    this.id = id;
    this.lanes = new Set(lanes); // default lanes
    this.start = 0;
    this.end = 10000;
    
    this.color = randomHue();

    this.accelCutoff = Infinity; // ignore cutoff by default
    this.MA = 1;                 
  }
}

class SeriesManager {
  constructor(containerEl, dataset, runId, analysisManager) {
    this.containerEl = containerEl;
    this.series = new Map();
    this.nextId = 1;
    this.dataset = dataset;
    this.runId = runId;
    this._computeLanes();
    this.analysisManager = analysisManager;
  }

  _computeLanes() {
    const laneSet = new Set();
    for (let i = 0; i < this.dataset.rowCount; i++) {
      if (this.dataset.col12_int[i] === this.runId) {
        laneSet.add(this.dataset.col5_int[i]);
      }
    }
    this.lanes = Array.from(laneSet).sort((a, b) => a - b);
  }

  addSeries() {
    const id = this.nextId++;
    const series = new Series(id, this.lanes);
    this.series.set(id, series);
    this._renderSeries(series);

    // register in AnalysisManager
    this.analysisManager.registerSeries(id, series.color);
  }

  removeSeries(id) {
    this.series.delete(id);
    const el = document.getElementById(`series-${id}`);
    if (el) el.remove();
    this.analysisManager.unregisterSeries(id);
  }

  reset(containerEl, dataset = null, runId = null) {
    this.containerEl.innerHTML = "";
    this.series.clear();
    this.nextId = 1;

    if (containerEl) this.containerEl = containerEl;
    if (dataset) this.dataset = dataset;
    if (runId !== null) this.runId = runId;

    this._computeLanes();
  }

  getConfig() {
    const configs = [];
    for (const [id, series] of this.series.entries()) {
      configs.push({
        id: series.id,
        color: series.color,
        lanes: Array.from(series.lanes),
        start: series.start,
        end: series.end,
        accelCutoff: series.accelCutoff,
        MA: series.MA,
      });
    }
    return configs;
  }

  getSeries(id) {
    return this.series.get(id) || null;
  }

  _renderSeries(series) {
    const wrapper = document.createElement("div");
    wrapper.className = "series-container";
    wrapper.id = `series-${series.id}`;
    wrapper.style.backgroundColor = series.color;

    const controls = document.createElement("div");
    controls.className = "series-controls";

    const label = document.createElement("span");
    label.className = "series-label";
    label.textContent = `Series ${series.id}`;
    controls.appendChild(label);

    // Lane checkboxes
    const laneBox = document.createElement("span");
    laneBox.textContent = "Lanes:";
    controls.appendChild(laneBox);

    this.lanes.forEach(lane => {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = series.lanes.has(lane);
      cb.addEventListener("change", () => {
        if (cb.checked) series.lanes.add(lane);
        else series.lanes.delete(lane);
      });
      controls.appendChild(cb);
      controls.appendChild(document.createTextNode(lane));
    });

    // Start input
    const startInput = document.createElement("input");
    startInput.type = "number";
    startInput.value = series.start;
    startInput.addEventListener("input", () => {
      series.start = parseFloat(startInput.value);
    });
    controls.appendChild(document.createTextNode(" Start:"));
    controls.appendChild(startInput);

    // End input
    const endInput = document.createElement("input");
    endInput.type = "number";
    endInput.value = series.end;
    endInput.addEventListener("input", () => {
      series.end = parseFloat(endInput.value);
    });
    controls.appendChild(document.createTextNode(" End:"));
    controls.appendChild(endInput);

    // Accel cutoff input
    const accelInput = document.createElement("input");
    accelInput.type = "number";
    accelInput.step = "0.1";
    accelInput.value = series.accelCutoff;
    accelInput.addEventListener("input", () => {
      series.accelCutoff = parseFloat(accelInput.value);
    });
    controls.appendChild(document.createTextNode(" Accel Cutoff:"));
    controls.appendChild(accelInput);

    // Moving average input
    const maInput = document.createElement("input");
    maInput.type = "number";
    maInput.min = "1";
    maInput.value = series.MA;
    maInput.addEventListener("input", () => {
      series.MA = parseInt(maInput.value, 10);
    });
    controls.appendChild(document.createTextNode(" MA:"));
    controls.appendChild(maInput);

    // Delete button
    const delBtn = document.createElement("button");
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => {
      this.removeSeries(series.id);
    });
    controls.appendChild(delBtn);

    wrapper.appendChild(controls);
    this.containerEl.appendChild(wrapper);
  }
}





// --- Helpers
function dot(a,b){ return a[0]*b[0]+a[1]*b[1]; }
function norm(a){ return Math.hypot(a[0], a[1]); }
function normalize(a){ const l=norm(a)||1; return [a[0]/l,a[1]/l]; }
function mat3identity(){
  return new Float32Array([1,0,0, 0,1,0, 0,0,1]);
}
// helper: apply a 3x3 mat to vec2
function applyMat3(m, p) {
  const x = p[0], y = p[1];
  return [
    m[0]*x + m[3]*y + m[6],
    m[1]*x + m[4]*y + m[7]
  ];
}
function randomHue() {
    const h = Math.floor(Math.random() * 360);
    return `hsl(${h}, 70%, 40%)`;
  }

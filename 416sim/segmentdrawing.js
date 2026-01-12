/**
 * Traffic Simulation – Global Namespace Framework with Draw Line Tool
 * Language: JavaScript (usable with normal <script src> tags)
 * Rendering: WebGL
 * Scope: Data model + renderer, exposed via window.TrafficSim
 */

(function(global){

/*********************************
 * Utility: IDs & Vectors
 *********************************/

function makeId(prefix = "id") {
  const now = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${now}_${rand}`;
}

function distanceSquared(a,b){
  const dx=a.x-b.x, dy=a.y-b.y; return dx*dx+dy*dy;
}

function closestPointOnSegment(p,a,b){
  const abx=b.x-a.x, aby=b.y-a.y;
  const apx=p.x-a.x, apy=p.y-a.y;
  const ab2=abx*abx+aby*aby;
  const t=Math.max(0,Math.min(1,(apx*abx+apy*aby)/ab2));
  return {x:a.x+abx*t,y:a.y+aby*t};
}

/***************************
 * Domain Model
 ***************************/

function Node(id, position, label){
  this.id = id;
  this.position = { x: position.x, y: position.y };
  this.label = label;
}

function Segment(id, from, to, speedLimitKph, lanes, elements, type){
  this.id = id;
  this.from = from;
  this.to = to;
  this.speedLimitKph = speedLimitKph;
  this.lanes = lanes;
  this.elements = elements || [];
  this.transient = {};
  this.type = type || "generic"; // NEW: segment type (road, generic, etc.)
}

/*********************
 * Store
 *********************/

function GraphStore(){
  this._nodes = new Map();
  this._segments = new Map();
  this._version = 0;
}

GraphStore.prototype._bump = function(){ this._version++; };

GraphStore.prototype.addNode = function(position, label){
  const id = makeId("node");
  const node = new Node(id, position, label);
  this._nodes.set(id, node);
  this._bump();
  return id;
};

GraphStore.prototype.updateNode = function(id, patch){
  const cur = this._nodes.get(id);
  if(!cur) throw new Error("Node not found");
  if(patch.position) cur.position = { x: patch.position.x, y: patch.position.y };
  if(patch.label !== undefined) cur.label = patch.label;
  this._nodes.set(id, cur);
  this._bump();
};

GraphStore.prototype.removeNode = function(id){
  if(!this._nodes.delete(id)) return;
  for(const [sid, seg] of Array.from(this._segments)){
    if(seg.from === id || seg.to === id) this._segments.delete(sid);
  }
  this._bump();
};

GraphStore.prototype.addSegment = function(params){
  const { from, to, speedLimitKph, lanes, elements = [], type = "generic" } = params;
  if(!this._nodes.has(from) || !this._nodes.has(to)) throw new Error("Missing node");
  const id = makeId("seg");
  const seg = new Segment(id, from, to, speedLimitKph, lanes, elements, type);
  this._segments.set(id, seg);
  this._bump();
  return id;
};

GraphStore.prototype.updateSegmentStatic = function(id, patch){
  const cur = this._segments.get(id);
  if(!cur) throw new Error("Segment not found");
  cur.speedLimitKph = patch.speedLimitKph ?? cur.speedLimitKph;
  cur.lanes = patch.lanes ?? cur.lanes;
  this._segments.set(id, cur);
  this._bump();
};

GraphStore.prototype.setSegmentTransient = function(id, transient){
  const cur = this._segments.get(id);
  if(!cur) throw new Error("Segment not found");
  cur.transient = Object.assign({}, cur.transient, transient);
  this._segments.set(id, cur);
  this._bump();
};

GraphStore.prototype.setSegmentElements = function(id, elements){
  const cur = this._segments.get(id);
  if(!cur) throw new Error("Segment not found");
  cur.elements = elements.slice();
  this._segments.set(id, cur);
  this._bump();
};

GraphStore.prototype.removeSegment = function(id){
  this._segments.delete(id);
  this._bump();
};

GraphStore.prototype.snapshot = function(){
  return {
    nodes: this._nodes,
    segments: this._segments,
    version: this._version,
  };
};

/***************************
 * Renderer (WebGL)
 ***************************/

function mat3Identity(){
  return [1,0,0,
          0,1,0,
          0,0,1];
}

function mat3Translate(tx, ty){
  return [1,0,0,
          0,1,0,
          tx,ty,1];
}

function mat3Scale(sx, sy){
  return [sx,0,0,
          0,sy,0,
          0,0,1];
}

function mat3Multiply(a,b){
  const out = new Array(9);
  for (let row=0; row<3; row++) {
    for (let col=0; col<3; col++) {
      out[col*3+row] =
        a[0*3+row]*b[col*3+0] +
        a[1*3+row]*b[col*3+1] +
        a[2*3+row]*b[col*3+2];
    }
  }
  return out;
}

function createProgram(gl, vsSrc, fsSrc){
  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, vsSrc); gl.compileShader(vs);
  if(!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(vs));
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs, fsSrc); gl.compileShader(fs);
  if(!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(fs));
  const prog = gl.createProgram();
  gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
  if(!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  return prog;
}

const VS = `
attribute vec2 a_pos;
uniform mat3 u_view;
uniform vec2 u_resolution;
vec2 worldToScreen(vec2 p){ vec3 hp = u_view * vec3(p,1.0); return hp.xy; }
void main(){
  vec2 s = worldToScreen(a_pos);
  vec2 clip = (s/u_resolution)*2.0-1.0;
  clip.y = -clip.y;
  gl_Position = vec4(clip,0.0,1.0);
  gl_PointSize = 5.0;
}`;

const FS = `
precision mediump float;
uniform vec4 u_color;
void main(){ gl_FragColor = u_color; }
`;

// Global tool state
const ToolState = {
  current: "pan", // default tool
  draw: {
    stage: 0,
    firstPoint: null,
    cursor: {x:0,y:0}
  }
};

function GraphRenderer(canvas){
  const gl = canvas.getContext("webgl", { antialias:true, alpha:false });
  if(!gl) throw new Error("WebGL not supported");
  this.gl = gl;
  this.canvas = canvas;
  this.program = createProgram(gl, VS, FS);
  this.a_pos = gl.getAttribLocation(this.program, "a_pos");
  this.u_view = gl.getUniformLocation(this.program, "u_view");
  this.u_resolution = gl.getUniformLocation(this.program, "u_resolution");
  this.u_color = gl.getUniformLocation(this.program, "u_color");
  this.vbo = gl.createBuffer();

  this.pan = {x:0,y:0};
  this.zoom = 1;
  this._attachControls();
}

GraphRenderer.viewMatrix = function(opts){
  const pan = opts.pan || {x:0,y:0};
  const zoom = opts.zoom || 1;
  return mat3Multiply(mat3Translate(pan.x, pan.y), mat3Scale(zoom, zoom));
};

GraphRenderer.prototype.setSize = function(w,h){
  this.canvas.width = w; this.canvas.height = h;
  this.gl.viewport(0,0,w,h);
};

GraphRenderer.prototype._bindBuffer = function(data){
  const gl = this.gl;
  gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
  gl.enableVertexAttribArray(this.a_pos);
  gl.vertexAttribPointer(this.a_pos,2,gl.FLOAT,false,0,0);
};

GraphRenderer.prototype._drawLines = function(data,color){
  const gl = this.gl;
  if(data.length===0) return;
  this._bindBuffer(data);
  gl.uniform4f(this.u_color,...color);
  gl.drawArrays(gl.LINES,0,data.length/2);
};

GraphRenderer.prototype._drawPoints = function(data,color){
  const gl = this.gl;
  if(data.length===0) return;
  this._bindBuffer(data);
  gl.uniform4f(this.u_color,...color);
  gl.drawArrays(gl.POINTS,0,data.length/2);
};

GraphRenderer.prototype.render = function(snapshot){
  const gl = this.gl;
  gl.useProgram(this.program);
  gl.uniform2f(this.u_resolution,this.canvas.width,this.canvas.height);
  const view = GraphRenderer.viewMatrix({pan:this.pan,zoom:this.zoom});
  gl.uniformMatrix3fv(this.u_view,false,new Float32Array(view));
  gl.clearColor(0.98,0.98,1.0,1.0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  // only draw thin lines for non-road segments
  const lineVerts=[];
  for(const seg of snapshot.segments.values()){
    if(seg.type === "road") continue;
    const a = snapshot.nodes.get(seg.from);
    const b = snapshot.nodes.get(seg.to);
    lineVerts.push(a.position.x,a.position.y,b.position.x,b.position.y);
  }
  this._drawLines(new Float32Array(lineVerts),[0.2,0.2,0.25,1.0]);

  const pointVerts=[];
  for(const n of snapshot.nodes.values()){
    pointVerts.push(n.position.x,n.position.y);
  }
  this._drawPoints(new Float32Array(pointVerts),[0.05,0.3,0.8,1.0]);

  // provisional drawing for draw tool (not roads)
  if(ToolState.current === "draw"){
    const cp = ToolState.draw.cursor;
    if(ToolState.draw.stage === 0){
      this._drawPoints(new Float32Array([cp.x,cp.y]), [0.8,0.2,0.2,1.0]);
    } else if(ToolState.draw.stage === 1){
      const fp = ToolState.draw.firstPoint;
      this._drawLines(new Float32Array([fp.x,fp.y,cp.x,cp.y]), [0.8,0.2,0.2,1.0]);
      this._drawPoints(new Float32Array([fp.x,fp.y,cp.x,cp.y]), [0.8,0.2,0.2,1.0]);
    }
  }
};

GraphRenderer.prototype._attachControls = function(){
  const canvas = this.canvas;
  let isPanning = false;
  let last = {x:0,y:0};

  canvas.addEventListener("mousemove", e => {
    const rect = canvas.getBoundingClientRect();
    const cx = (e.clientX - rect.left - this.pan.x)/this.zoom;
    const cy = (e.clientY - rect.top - this.pan.y)/this.zoom;
    ToolState.draw.cursor = {x:cx,y:cy};

    if(isPanning){
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      this.pan.x += dx;
      this.pan.y += dy;
      last = {x:e.clientX,y:e.clientY};
    }
  });

  canvas.addEventListener("mousedown", e => {
    if((e.button === 1) || (e.button === 0 && ToolState.current === "pan")){
      isPanning = true;
      last = {x:e.clientX,y:e.clientY};
      e.preventDefault();
    }
    if(e.button === 0 && ToolState.current === "draw"){
      const store = global.TrafficSim._activeStore;
      if(ToolState.draw.stage === 0){
        ToolState.draw.firstPoint = {...ToolState.draw.cursor};
        ToolState.draw.stage = 1;
      } else if(ToolState.draw.stage === 1){
        const n1 = store.addNode(ToolState.draw.firstPoint, "");
        const n2 = store.addNode(ToolState.draw.cursor, "");
        store.addSegment({from:n1,to:n2,lanes:1,speedLimitKph:50});
        ToolState.draw.stage = 0;
        ToolState.draw.firstPoint = null;
      }
    }
  });

  canvas.addEventListener("mouseup", e => {
    if(e.button === 1 || (e.button === 0 && ToolState.current === "pan")){
      isPanning=false;
    }
  });

  canvas.addEventListener("wheel", e => {
    const zoomFactor = 1.05;
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    const worldX = (cx - this.pan.x) / this.zoom;
    const worldY = (cy - this.pan.y) / this.zoom;

    if(e.deltaY < 0) this.zoom *= zoomFactor;
    else this.zoom /= zoomFactor;

    this.pan.x = cx - worldX * this.zoom;
    this.pan.y = cy - worldY * this.zoom;

    e.preventDefault();
  }, { passive:false });
};

/***********************
 * Bootstrap
 ***********************/

function initFramework(canvas){
  const store = new GraphStore();
  global.TrafficSim._activeStore = store;
  const renderer = new GraphRenderer(canvas);
  const rect = canvas.getBoundingClientRect();
  renderer.setSize(rect.width|0, rect.height|0);

  function mountDemo(){
    function loop(){
      renderer.render(store.snapshot());
      requestAnimationFrame(loop);
    }
    loop();
  }

  return { store, renderer, mountDemo };
}

// Export
global.TrafficSim = {
  GraphStore,
  GraphRenderer,
  initFramework,
  ToolState
};

})(window);

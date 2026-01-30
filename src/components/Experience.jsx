import React, { useRef, useEffect, useMemo, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import * as handPoseDetection from '@tensorflow-models/hand-pose-detection';
import '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-backend-webgl';
import { audioSynth } from '../utils/audio';

// --- Configuration & Constants ---
const TARGET_LANDMARKS = [4, 8, 12, 16, 20];
const RIPPLE_MAP_SIZE = 1024;

// --- Shader Material ---
const WaterRippleMaterial = {
  uniforms: {
    uTexture: { value: null },      // Camera Feed
    uDisplacement: { value: null }, // Ripple Data (R channel)
    uTime: { value: 0 },
    uColor1: { value: new THREE.Color('#ffffff') }, 
    uColor2: { value: new THREE.Color('#ffffff') }, 
    uUseTexture: { value: 0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D uTexture;
    uniform sampler2D uDisplacement;
    uniform float uTime;
    uniform vec3 uColor1;
    uniform vec3 uColor2;
    uniform float uUseTexture;
    varying vec2 vUv;

    void main() {
      // Sample Displacement
      vec4 dispData = texture2D(uDisplacement, vUv);
      float displacement = dispData.r; // Height/Intensity from Red channel
      float handMix = dispData.g;      // 0 -> Left, 1 -> Right

      // Radial silver gradient background (no camera preview)
      vec2 center = vec2(0.5, 0.5);
      float d = distance(vUv, center);
      float t = smoothstep(0.0, 0.75, d);
      vec3 silverCenter = vec3(0.84, 0.86, 0.90);
      vec3 silverEdge = vec3(0.62, 0.64, 0.68);
      vec3 grad = mix(silverCenter, silverEdge, t);

      float distortionStrength = 0.04;
      vec2 distortedUv = vUv + vec2(displacement * distortionStrength);
      vec4 texColor = texture2D(uTexture, distortedUv);
      vec3 base = grad;
      if (uUseTexture > 0.5) {
        base = texColor.rgb;
      }

      // Highlight/Glow based on displacement
      float lightIntensity = displacement * dispData.a; 
      vec3 tint = mix(uColor1, uColor2, handMix);
      vec3 highlight = tint * lightIntensity;

      // Final Composite
      vec3 finalColor = base + highlight;
      gl_FragColor = vec4(finalColor, 1.0);
    }
  `
};

// --- Ripple Logic ---
class Ripple {
  constructor(x, y, settings, initialRadius, handIndex) {
    this.x = x;
    this.y = y;
    this.life = 1.0; 
    this.alive = true;
    
    // Physical Properties
    this.radius = initialRadius; // Start radius based on finger distance
    this.maxRadius = settings.size + initialRadius; 
    this.speed = settings.speed;         
    this.friction = settings.friction;   
    this.handIndex = handIndex || 0;
    this.color1 = settings.color1;
    this.color2 = settings.color2;
    this.ringWidth = settings.ringWidth;
    this.jitter = settings.jitter;
    this.noiseSeed = Math.random() * 6.28318;
    this.age = 0.0;
    this.initialAlpha = settings.opacity || 1.0;
  }

  update() {
    this.age += 1.0;
    const j = Math.sin(this.age * 0.12 + this.noiseSeed) * this.jitter;
    this.radius += this.speed + j;
    this.speed *= this.friction; 
    this.life -= 0.01; 
    if (this.life <= 0) {
      this.alive = false;
    }
  }

  draw(ctx) {
    if (!this.alive) return;

    // User requested: "Hollow circle", "Silver white"
    // We draw into the displacement map.
    // A hollow circle (stroke) creates a ring wave.
    
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
    
    // Color logic:
    // We need Red channel for displacement height.
    // Alpha controls fade.
    // Encode hand index in Green channel: 0 for left, 255 for right.
    
    const alpha = this.life * this.initialAlpha;
    const g = this.handIndex === 1 ? 255 : 0;
    ctx.strokeStyle = `rgba(255, ${g}, 0, ${alpha})`; 
    ctx.lineWidth = this.ringWidth;
    ctx.stroke();
  }
}

// --- Main Scene Component ---
const RippleScene = ({ videoStream, settings, debugCanvasRef }) => {
  const meshRef = useRef();
  const shaderRef = useRef();
  
  // Logic Refs
  const rippleCanvasRef = useRef(document.createElement('canvas'));
  const ripplesRef = useRef([]); 
  const handModelRef = useRef(null);
  const frameCounterRef = useRef(0);
  const prevCenterRef = useRef(null);

  // Initialize Ripple Texture
  const rippleTexture = useMemo(() => {
    const canvas = rippleCanvasRef.current;
    canvas.width = RIPPLE_MAP_SIZE;
    canvas.height = RIPPLE_MAP_SIZE;
    return new THREE.CanvasTexture(canvas);
  }, []);

  // Initialize Video Texture
  const videoTexture = useMemo(() => {
    if (!videoStream) return null;
    const video = document.createElement('video');
    video.srcObject = videoStream;
    video.play();
    video.playsInline = true;
    return new THREE.VideoTexture(video);
  }, [videoStream]);

  // Load MediaPipe Model
  useEffect(() => {
    const loadModel = async () => {
      try {
        console.log("Loading MediaPipe model...");
        const model = await handPoseDetection.createDetector(
          handPoseDetection.SupportedModels.MediaPipeHands,
          {
            runtime: 'mediapipe',
            solutionPath: 'https://cdn.jsdelivr.net/npm/@mediapipe/hands',
            modelType: 'full'
          }
        );
        handModelRef.current = model;
        console.log("MediaPipe Hands loaded successfully.");
      } catch (err) {
        console.error("Failed to load MediaPipe:", err);
        try {
          console.log("Falling back to TFJS runtime...");
          const tfModel = await handPoseDetection.createDetector(
            handPoseDetection.SupportedModels.MediaPipeHands,
            {
              runtime: 'tfjs',
              modelType: 'lite'
            }
          );
          handModelRef.current = tfModel;
          console.log("TFJS hand detector loaded successfully.");
        } catch (err2) {
          console.error("Failed to load TFJS hand detector:", err2);
        }
      }
    };
    loadModel();
  }, []);

  // Animation Loop
  useEffect(() => {
    if (!videoStream) {
      console.log("Waiting for video stream...");
      return;
    }
    
    const rippleCanvas = rippleCanvasRef.current;
    const rippleCtx = rippleCanvas.getContext('2d');
    
    const helperVideo = document.createElement('video');
    helperVideo.srcObject = videoStream;
    helperVideo.muted = true;
    helperVideo.playsInline = true;
    helperVideo.width = 640;
    helperVideo.height = 480;
    
    // Ensure video is playing before starting loop
    helperVideo.onloadedmetadata = () => {
      helperVideo.play().then(() => {
        console.log("Helper video playing, starting loop.");
        loop();
      }).catch(e => console.error("Helper video play failed:", e));
    };

    let animationFrame;

    const loop = async () => {
      frameCounterRef.current++;
      // Clear Ripple Canvas (or fade)
      // "Slowly disappear" -> Trail effect
      rippleCtx.globalCompositeOperation = 'source-over';
      rippleCtx.fillStyle = 'rgba(0, 0, 0, 0.1)'; // Fade speed
      rippleCtx.fillRect(0, 0, RIPPLE_MAP_SIZE, RIPPLE_MAP_SIZE);

      // Debug Canvas
      if (debugCanvasRef.current) {
        const debugCtx = debugCanvasRef.current.getContext('2d');
        // Check if canvas size matches window, update if not
        if (debugCanvasRef.current.width !== window.innerWidth || debugCanvasRef.current.height !== window.innerHeight) {
           debugCanvasRef.current.width = window.innerWidth;
           debugCanvasRef.current.height = window.innerHeight;
        }
        
        debugCtx.clearRect(0, 0, debugCanvasRef.current.width, debugCanvasRef.current.height);

        // Hand Detection always runs; trackingEnabled only controls markers visibility
        if (handModelRef.current && helperVideo.readyState >= 2) {
          try {
            const predictions = await handModelRef.current.estimateHands(helperVideo);
            
            if (predictions.length > 0) {
              const vw = helperVideo.videoWidth || 640;
              const vh = helperVideo.videoHeight || 480;

              predictions.slice(0, 2).forEach((hand, i) => {
                const p4 = hand.keypoints[4];
                const p8 = hand.keypoints[8];
                const p12 = hand.keypoints[12];
                const active = [p4, p8, p12].filter(Boolean);
                if (active.length < 2) return;

                const centerX = active.reduce((s, p) => s + p.x, 0) / active.length;
                const centerY = active.reduce((s, p) => s + p.y, 0) / active.length;
                const rippleX = (centerX / vw) * RIPPLE_MAP_SIZE;
                const rippleY = (centerY / vh) * RIPPLE_MAP_SIZE;

                let spread = 0;
                if (p4 && p8) {
                  spread = Math.hypot(p4.x - p8.x, p4.y - p8.y);
                } else {
                  spread = Math.hypot(active[0].x - active[1].x, active[0].y - active[1].y);
                }
                const initialRadius = (spread / vw) * RIPPLE_MAP_SIZE * 0.35;

                if (settings.trackingEnabled) {
                  TARGET_LANDMARKS.forEach(id => {
                    const pt = hand.keypoints[id];
                    if (!pt) return;
                    const mx = (pt.x / vw) * window.innerWidth;
                    const my = (pt.y / vh) * window.innerHeight;
                    debugCtx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
                    debugCtx.lineWidth = 1.5;
                    debugCtx.beginPath();
                    debugCtx.arc(mx, my, 10, 0, Math.PI * 2);
                    debugCtx.stroke();
                    debugCtx.fillStyle = 'rgba(255, 255, 255, 0.9)';
                    debugCtx.font = '10px sans-serif';
                    debugCtx.textAlign = 'center';
                    debugCtx.textBaseline = 'middle';
                    debugCtx.fillText(id, mx, my);
                  });
                }

                const prev = prevCenterRef.current;
                const moved = !prev ? true : Math.hypot(rippleX - prev.x, rippleY - prev.y) > 2;
                if (moved && frameCounterRef.current % settings.rippleDensity === 0) {
                  const handed = (hand.handedness && /right/i.test(hand.handedness)) ? 1 : ((hand.handedness && /left/i.test(hand.handedness)) ? 0 : i);
                  ripplesRef.current.push(new Ripple(rippleX, rippleY, settings, initialRadius, handed));
                }
                prevCenterRef.current = { x: rippleX, y: rippleY };
              });
            }
          } catch (e) {
             console.warn("Detection error:", e);
          }
        }
      }

      // Draw Ripples
      rippleCtx.globalCompositeOperation = 'lighter'; 
      ripplesRef.current = ripplesRef.current.filter(r => r.alive);
      ripplesRef.current.forEach(r => {
        r.update();
        r.draw(rippleCtx);
      });
      
      rippleTexture.needsUpdate = true;
      animationFrame = requestAnimationFrame(loop);
    };
    
    // loop(); // Started in onloadedmetadata
    
    return () => {
        cancelAnimationFrame(animationFrame);
        helperVideo.pause();
        helperVideo.srcObject = null;
    };
  }, [videoStream, rippleTexture, settings]);

  useFrame((state) => {
    if (shaderRef.current) {
      shaderRef.current.uniforms.uTime.value = state.clock.elapsedTime;
      if (videoTexture) shaderRef.current.uniforms.uTexture.value = videoTexture;
      shaderRef.current.uniforms.uDisplacement.value = rippleTexture;
      shaderRef.current.uniforms.uColor1.value = new THREE.Color(settings.color1);
      shaderRef.current.uniforms.uColor2.value = new THREE.Color(settings.color2);
      shaderRef.current.uniforms.uUseTexture.value = settings.showCamera ? 1 : 0;
    }
  });

  return (
    <mesh ref={meshRef}>
      <planeGeometry args={[16, 9]} />
      <shaderMaterial
        ref={shaderRef}
        args={[WaterRippleMaterial]}
        transparent={true}
      />
    </mesh>
  );
};

// Helper for Debug Canvas inside Canvas (Wait, standard HTML cannot be inside R3F Canvas unless using <Html>)
// Actually, we should put the Debug Canvas OUTSIDE the R3F Canvas but inside the mirrored container.
// So RippleScene shouldn't render the debug canvas itself directly.
// We can use a Portal or just move the logic up. 
// OR, we can pass a Ref to RippleScene that points to a canvas outside.

// Let's refactor: RippleScene takes `debugCanvasRef` as prop.
// const HtmlOverlay = React.forwardRef((props, ref) => (
//   <canvas 
//     ref={ref}
//     style={{ 
//       position: 'absolute', 
//       top: 0, 
//       left: 0, 
//       width: '100%', 
//       height: '100%', 
//       pointerEvents: 'none', 
//       zIndex: 10 
//     }} 
//   />
// ));


// --- UI Panel Component ---
const ControlPanel = ({ settings, setSettings }) => {
  const handleChange = (key, value) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const panelStyle = {
    position: 'absolute',
    top: '20px',
    right: '20px',
    width: '260px',
    padding: '24px',
    background: 'rgba(255, 255, 255, 0.05)',
    backdropFilter: 'blur(20px)',
    borderRadius: '16px',
    border: '1px solid rgba(255, 255, 255, 0.2)',
    color: '#F3F4F6', // Gray-100
    zIndex: 100,
    display: 'flex',
    flexDirection: 'column',
    gap: '20px',
    fontFamily: 'sans-serif',
    fontSize: '13px',
    boxShadow: '0 10px 30px rgba(0,0,0,0.1)'
  };

  const rowStyle = {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  };

  const labelStyle = {
    display: 'flex',
    justifyContent: 'space-between',
    opacity: 0.8,
    marginBottom: '4px'
  };

  const sliderStyle = {
    width: '100%',
    accentColor: '#E5E7EB',
    cursor: 'pointer',
    height: '4px',
    borderRadius: '2px'
  };

  return (
    <div className="controls-panel" style={panelStyle}>
      <div style={{ fontSize: '1.2em', fontWeight: '500', letterSpacing: '0.05em', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '12px' }}>
        CONTROLS
      </div>

      {/* Size */}
      <div style={rowStyle}>
        <div style={labelStyle}>
          <span>Ripple Size</span>
          <span>{settings.size}px</span>
        </div>
        <input 
          type="range" min="10" max="300" step="10"
          value={settings.size}
          onChange={(e) => handleChange('size', parseInt(e.target.value))}
          style={sliderStyle}
        />
      </div>

      {/* Opacity */}
      <div style={rowStyle}>
        <div style={labelStyle}>
          <span>Opacity</span>
          <span>{settings.opacity.toFixed(1)}</span>
        </div>
        <input 
          type="range" min="0.1" max="1.0" step="0.1"
          value={settings.opacity}
          onChange={(e) => handleChange('opacity', parseFloat(e.target.value))}
          style={sliderStyle}
        />
      </div>

      {/* Friction */}
      <div style={rowStyle}>
        <div style={labelStyle}>
          <span>Friction</span>
          <span>{settings.friction.toFixed(2)}</span>
        </div>
        <input 
          type="range" min="0.85" max="0.99" step="0.01"
          value={settings.friction}
          onChange={(e) => handleChange('friction', parseFloat(e.target.value))}
          style={sliderStyle}
        />
      </div>

      {/* Speed */}
      <div style={rowStyle}>
        <div style={labelStyle}>
          <span>Speed</span>
          <span>{settings.speed.toFixed(1)}</span>
        </div>
        <input 
          type="range" min="0.5" max="5.0" step="0.1"
          value={settings.speed}
          onChange={(e) => handleChange('speed', parseFloat(e.target.value))}
          style={sliderStyle}
        />
      </div>

      {/* Ripple Density */}
      <div style={rowStyle}>
        <div style={labelStyle}>
          <span>Ripple Density</span>
          <span>{settings.rippleDensity}</span>
        </div>
        <input
          type="range" min="1" max="20" step="1"
          value={settings.rippleDensity}
          onChange={(e) => handleChange('rippleDensity', parseInt(e.target.value))}
          style={sliderStyle}
        />
      </div>

      {/* Hand Tracking */}
      <div style={{ ...rowStyle, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>Enable Hand Tracking</span>
        <input
          type="checkbox"
          checked={settings.trackingEnabled}
          onChange={(e) => handleChange('trackingEnabled', e.target.checked)}
          style={{ accentColor: '#E5E7EB', transform: 'scale(1.2)', cursor: 'pointer' }}
        />
      </div>

      {/* Camera Preview */}
      <div style={{ ...rowStyle, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>Show Camera</span>
        <input 
          type="checkbox"
          checked={settings.showCamera}
          onChange={(e) => handleChange('showCamera', e.target.checked)}
          style={{ accentColor: '#E5E7EB', transform: 'scale(1.2)', cursor: 'pointer' }}
        />
      </div>

      {/* Tint (Two hands) */}
      <div style={rowStyle}>
        <div style={labelStyle}><span>Tint</span></div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
          <div>
            <div style={{ opacity: 0.7, marginBottom: 4 }}>Ripple 1 (Left)</div>
            <input 
              type="color"
              value={settings.color1}
              onChange={(e) => handleChange('color1', e.target.value)}
              style={{ width: '100%', height: '32px', border: 'none', borderRadius: '4px', cursor: 'pointer', background: 'none' }}
            />
          </div>
          <div>
            <div style={{ opacity: 0.7, marginBottom: 4 }}>Ripple 2 (Right)</div>
            <input 
              type="color"
              value={settings.color2}
              onChange={(e) => handleChange('color2', e.target.value)}
              style={{ width: '100%', height: '32px', border: 'none', borderRadius: '4px', cursor: 'pointer', background: 'none' }}
            />
          </div>
        </div>
      </div>

      {/* Ring Width */}
      <div style={rowStyle}>
        <div style={labelStyle}>
          <span>Ring Width</span>
          <span>{settings.ringWidth}px</span>
        </div>
        <input 
          type="range" min="1" max="12" step="1"
          value={settings.ringWidth}
          onChange={(e) => handleChange('ringWidth', parseInt(e.target.value))}
          style={sliderStyle}
        />
      </div>

      {/* Radius Jitter */}
      <div style={rowStyle}>
        <div style={labelStyle}>
          <span>Radius Jitter</span>
          <span>{settings.jitter.toFixed(2)}</span>
        </div>
        <input 
          type="range" min="0.0" max="1.0" step="0.05"
          value={settings.jitter}
          onChange={(e) => handleChange('jitter', parseFloat(e.target.value))}
          style={sliderStyle}
        />
      </div>
    </div>
  );
};

// --- Main App Export ---
const Experience = ({ started }) => {
  const [stream, setStream] = useState(null);
  const debugCanvasRef = useRef(null);
  
  const [settings, setSettings] = useState({
    speed: 2.0,
    size: 100,
    friction: 0.95,
    opacity: 0.8,
    color1: '#ffffff',
    color2: '#ffffff',
    ringWidth: 4,
    jitter: 0.2,
    trail: true,
    showCamera: false,
    rippleDensity: 10,
    trackingEnabled: true
  });

  useEffect(() => {
    // Check if started prop is even passed (App.jsx might pass it or just render conditionally)
    // In new App.jsx: {started && <Experience />}
    // So this component only mounts when started.
    
    navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } })
      .then(setStream)
      .catch(err => console.error("Camera access denied:", err));
    
    audioSynth.start();

    return () => {
      audioSynth.stop();
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  return (
    <div id="canvas-container" style={{ width: '100vw', height: '100vh', position: 'relative', overflow: 'hidden' }}>
      
      {/* Scene Container - Mirrored */}
      <div style={{ 
        width: '100%', 
        height: '100%', 
        transform: 'scaleX(-1)', // CSS Mirroring
        position: 'relative'
      }}>
        {stream && (
          <>
            <Canvas camera={{ position: [0, 0, 5] }}>
              {/* Pass ref to debug canvas so logic can draw on it */}
              <RippleScene 
                videoStream={stream} 
                settings={settings} 
                debugCanvasRef={debugCanvasRef}
              />
            </Canvas>
            {/* Debug Canvas - Inside Mirrored Container */}
            <canvas 
              ref={debugCanvasRef}
              style={{ 
                position: 'absolute', 
                top: 0, 
                left: 0, 
                width: '100%', 
                height: '100%', 
                pointerEvents: 'none', 
                zIndex: 10 
              }} 
            />
          </>
        )}
      </div>

      {/* Control Panel - NOT Mirrored (Outside container) */}
      <ControlPanel settings={settings} setSettings={setSettings} />
    </div>
  );
};

export default Experience;

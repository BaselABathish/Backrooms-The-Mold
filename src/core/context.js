// The WebGL renderer, scene and camera shared by every module.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export const canvas = document.getElementById('c');
export const isTouch = matchMedia('(pointer: coarse)').matches || ('ontouchstart' in window);

export const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
renderer.setPixelRatio(1);
renderer.toneMapping = THREE.NoToneMapping;
renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // the post passes do their own colour conversion
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false;                   // only the flashlight casts shadows; updated while it's on

const hasCBF = renderer.extensions.has('EXT_color_buffer_float');
const hasCBHF = renderer.extensions.has('EXT_color_buffer_half_float');
export const rtType = (hasCBF || hasCBHF) ? THREE.HalfFloatType : THREE.UnsignedByteType; // HDR render targets where supported
export const expoType = hasCBF ? THREE.FloatType : (hasCBHF ? THREE.HalfFloatType : null);   // precision for the 1x1 exposure buffer

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
export const camera = new THREE.PerspectiveCamera(66, 4 / 3, 0.05, 70);
camera.rotation.order = 'YXZ';
export const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture; // replaced by a capture of the corridor once it is built
scene.environmentIntensity = 0.15;

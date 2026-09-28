# AUR Fleet Scale v2

Nine original, Blender-ready spacecraft form a real-meter scale ladder from a 2.4 m autonomous drone to a 5 km orbital station. Every asset is isolated in its own folder with editable source, portable exports, textures, references, transparent QA renders, and machine-readable audit evidence.

| Asset | Class | Dimensions (m) |
| --- | --- | --- |
| `aur-wisp-drone` | autonomous reconnaissance drone | 2.4 × 1.8 × 0.72 |
| `aur-lance-interceptor` | single-seat interceptor | 9 × 14 × 3 |
| `aur-wayfarer-shuttle` | crew and cargo shuttle | 24 × 35 × 8.5 |
| `aur-bastion-corvette` | armored patrol corvette | 46 × 90 × 18 |
| `aur-vigil-frigate` | long-keel escort frigate | 92 × 220 × 38 |
| `aur-helix-destroyer` | spinal-rail heavy destroyer | 180 × 450 × 72 |
| `aur-atlas-cruiser` | fleet command cruiser | 420 × 850 × 160 |
| `aur-ark-carrier` | trident fleet carrier | 780 × 1600 × 240 |
| `aur-citadel-station` | modular orbital station | 5000 × 5000 × 2600 |

## Contents

Each asset folder contains:

- an editable `.blend` master;
- a self-contained `.glb` for glTF runtimes;
- an `.fbx` interchange export;
- portable base-color, normal, and metallic-roughness PNG maps;
- original concept and model-locked reference art;
- four 1536 px transparent-background QA renders;
- visual-comparison, portable-material, and runtime audit JSON;
- a deterministic Blender rebuild script.

The top-level [`catalog.json`](catalog.json) is the integration index. These models are deliberately not added to the app's legacy `assets/ships/manifest.json`, whose normalized `main-s`/`main-m`/`main-l` roles do not preserve this fleet's physically meaningful scale ladder.

## Rebuild

Run an asset wrapper through Blender in background mode:

```powershell
& $env:BLENDER_EXE --background --python .\aur-wisp-drone\build_aur-wisp-drone.py
```

The shared generator is `_shared/fleet_builder.py`. It creates all geometry from first principles and does not import third-party models.

## Runtime notes

- Units are meters, forward is `+Y`, and up is `+Z`.
- There is no floor, display base, ground plane, backdrop, or opaque background in any model.
- Hero PBR materials use embedded image-backed base color, tangent-space normal, and metallic-roughness inputs so they survive Blender-to-glTF export.
- The GLBs are validated as portable glTF 2.0 assets and can be loaded by Babylon.js or Three.js. The `.blend` and `.fbx` siblings support DCC and game-engine workflows.

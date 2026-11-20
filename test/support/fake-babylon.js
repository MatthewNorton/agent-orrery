'use strict';

// The Babylon a generated world is made of (meshes, shader materials, raw textures, a glow layer),
// faked with Babylon's own disposal rules: a mesh takes its children along, and its material only
// when asked; a material takes its textures only when asked.

/**
 * `refuse(kind, name)` makes Babylon throw while it makes that 'mesh' or 'material', or while the
 * glow layer excludes that mesh ('glow'). `live()` is what has been made and not disposed.
 */
function fakeBabylon(refuse = () => false) {
  const meshes = [], materials = [], textures = [];
  const check = (kind, name) => { if (refuse(kind, name)) throw new Error(`no ${kind} ${name}`); };
  class Mesh {
    constructor(name) {
      check('mesh', name);
      Object.assign(this, { name, material: null, parent: null, disposed: false, position: {} });
      meshes.push(this);
    }
    setEnabled() {}
    isDisposed() { return this.disposed; }
    dispose(doNotRecurse = false, disposeMaterialAndTextures = false) {
      this.disposed = true;
      if (!doNotRecurse) {
        for (const child of meshes) if (child.parent === this && !child.disposed) child.dispose(false, disposeMaterialAndTextures);
      }
      if (disposeMaterialAndTextures && this.material) this.material.dispose(false, true);
    }
  }
  class ShaderMaterial {
    constructor(name) {
      check('material', name);
      Object.assign(this, { name, textures: {}, disposed: false });
      materials.push(this);
    }
    setTexture(sampler, texture) { this.textures[sampler] = texture; }
    setFloat() {}
    setColor3() {}
    setVector2() {}
    setVector3() {}
    setMatrix() {}
    dispose(forceDisposeEffect = false, forceDisposeTextures = false) {
      this.disposed = true;
      if (forceDisposeTextures) for (const texture of Object.values(this.textures)) texture.dispose();
    }
  }
  class Matrix { static Scaling() { return new Matrix(); } static Identity() { return new Matrix(); } }
  const rawTexture = (data, width, height) => {
    const texture = { data, width, height, disposed: false, dispose() { texture.disposed = true; } };
    textures.push(texture);
    return texture;
  };
  const BABYLON = {
    Mesh, ShaderMaterial, Matrix, VertexData: class { applyToMesh() {} }, Vector2: class {},
    Vector3: { Zero: () => ({ x: 0, y: 0, z: 0 }) },
    Constants: { ALPHA_COMBINE: 2, ALPHA_ADD: 1 },
    Color3: { White: () => ({}), Lerp: () => ({}) },
    MeshBuilder: { CreateSphere: (name) => new Mesh(name) },
    RawTexture: { CreateRGBATexture: rawTexture },
    Texture: { TRILINEAR_SAMPLINGMODE: 3, WRAP_ADDRESSMODE: 1, CLAMP_ADDRESSMODE: 0 },
  };
  const glow = () => {
    const excluded = new Set();
    return {
      excluded,
      addExcludedMesh(mesh) { check('glow', mesh.name); excluded.add(mesh.name); },
      removeExcludedMesh(mesh) { excluded.delete(mesh.name); },
    };
  };
  const names = (list) => list.filter((made) => !made.disposed).map((made) => made.name);
  const live = () => ({ meshes: names(meshes), materials: names(materials) });
  return { BABYLON, meshes, materials, textures, glow, live };
}

module.exports = { fakeBabylon };

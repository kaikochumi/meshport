import { MathUtils, WebIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer/decoder";

const MESHOPT = "EXT_meshopt_compression";
const QUANTIZATION = "KHR_mesh_quantization";
const GLB_MAGIC = 0x46546c67;

function dequantizeAccessor(accessor) {
  if (!accessor) return;
  const source = accessor.getArray();
  if (!source) return;

  const componentType = accessor.getComponentType();
  const normalized = accessor.getNormalized();
  if (componentType === 5126 && !normalized) return;

  const target = new Float32Array(source.length);
  for (let index = 0; index < source.length; index += 1) {
    target[index] = normalized
      ? MathUtils.decodeNormalizedInt(source[index], componentType)
      : source[index];
  }

  accessor.setArray(target).setNormalized(false);
}

function dequantize() {
  return (document) => {
    for (const mesh of document.getRoot().listMeshes()) {
      for (const primitive of mesh.listPrimitives()) {
        for (const semantic of primitive.listSemantics()) {
          if (semantic.startsWith("JOINTS_")) continue;
          dequantizeAccessor(primitive.getAttribute(semantic));
        }
        for (const target of primitive.listTargets()) {
          for (const semantic of target.listSemantics()) {
            if (semantic.startsWith("JOINTS_")) continue;
            dequantizeAccessor(target.getAttribute(semantic));
          }
        }
      }
    }
  };
}

export async function decodeTripoGlb(buffer) {
  if (!(buffer instanceof ArrayBuffer)) {
    throw new TypeError("Expected the GLB as an ArrayBuffer.");
  }
  if (buffer.byteLength < 12) {
    throw new Error("The GLB is too small.");
  }

  const header = new DataView(buffer);
  if (header.getUint32(0, true) !== GLB_MAGIC) {
    throw new Error("The file is not a GLB.");
  }
  if (header.getUint32(4, true) !== 2) {
    throw new Error("Only GLB version 2 is supported.");
  }

  await MeshoptDecoder.ready;

  const io = new WebIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "meshopt.decoder": MeshoptDecoder });

  const document = await io.readBinary(new Uint8Array(buffer));
  await document.transform(dequantize());

  if (!document.getRoot().listMeshes().length) {
    throw new Error("The GLB does not contain any meshes.");
  }

  for (const extension of document.getRoot().listExtensionsUsed()) {
    if (extension.extensionName === MESHOPT || extension.extensionName === QUANTIZATION) {
      extension.dispose();
    }
  }

  const output = await io.writeBinary(document);
  return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
}

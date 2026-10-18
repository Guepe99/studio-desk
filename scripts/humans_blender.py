"""Stage 1 of build_humans.py, run inside Blender with the MPFB 2 extension and the MakeHuman
system assets (CC0) installed: one GLB per body variant, each with the MakeHuman base mesh, the
game-engine rig and its weights, eyes, eyebrows, eyelashes, hair and shoes, plus a JSON with the
rig's bone heads and tails (glTF axes: Y up, facing +Z).

    blender -b --factory-startup --python scripts/humans_blender.py -- <out dir> <variants.json>

The variants (macro sliders, face targets, assets) come from build_humans.VARIANTS, passed as
JSON so this file needs nothing outside Blender.
"""
import json
import os
import sys

import bpy

ext = sys.modules.get("bl_ext.user_default.mpfb")
if ext is None:
    import addon_utils
    addon_utils.enable("bl_ext.user_default.mpfb", default_set=True)
from bl_ext.user_default.mpfb.services.humanservice import HumanService  # noqa: E402
from bl_ext.user_default.mpfb.services.locationservice import LocationService  # noqa: E402
from bl_ext.user_default.mpfb.services.targetservice import TargetService  # noqa: E402

out_dir, variants_file = sys.argv[sys.argv.index("--") + 1:][:2]
VARIANTS = json.load(open(variants_file))
DATA = LocationService.get_user_data()


def to_gltf(v):
    """Blender Z-up to glTF Y-up (the exporter's +Y up conversion)."""
    return [v[0], v[2], -v[1]]


def build(name, spec):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    macro = TargetService.get_default_macro_info_dict()
    macro.update({k: v for k, v in spec["macro"].items() if k != "race"})
    macro["race"] = spec["macro"]["race"]
    basemesh = HumanService.create_human(macro_detail_dict=macro)
    for target, value in spec.get("targets", {}).items():
        TargetService.load_target(basemesh, TargetService.target_full_path(target), weight=value)
    rig = HumanService.add_builtin_rig(basemesh, "game_engine")
    for kind, asset in spec["assets"].items():
        path = os.path.join(DATA, asset)
        HumanService.add_mhclo_asset(path, basemesh, asset_type=kind, subdiv_levels=0, material_type="MAKESKIN")
    # keep the feet under the shoes: build_humans.py cuts the shoes down to football boots
    for m in list(basemesh.modifiers):
        if m.type == "MASK" and m.name != "Hide helpers":
            basemesh.modifiers.remove(m)

    # bake the shape keys into the mesh so the exporter sees the final shape
    bpy.context.view_layer.objects.active = basemesh
    if basemesh.data.shape_keys:
        bpy.ops.object.shape_key_remove(all=True, apply_mix=True)

    bones = {b.name: {"head": to_gltf(rig.matrix_world @ b.head_local), "tail": to_gltf(rig.matrix_world @ b.tail_local),
                 "parent": b.parent.name if b.parent else None}
             for b in rig.data.bones}
    parts = {o.name: (o.get("asset_source") or "body") for o in rig.children_recursive if o.type == "MESH"}
    json.dump({"bones": bones, "parts": parts}, open(os.path.join(out_dir, f"{name}.json"), "w"), indent=1)

    bpy.ops.object.select_all(action="DESELECT")
    rig.select_set(True)
    for o in rig.children_recursive:
        o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=os.path.join(out_dir, f"{name}.glb"), export_format="GLB", use_selection=True,
                              export_apply=True, export_animations=False, export_morph=False, export_skins=True,
                              export_materials="EXPORT", export_image_format="NONE", export_yup=True)
    print("built", name, parts)


os.makedirs(out_dir, exist_ok=True)
for name, spec in VARIANTS.items():
    build(name, spec)

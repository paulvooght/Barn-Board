#!/usr/bin/env python3
"""
export_sam_decoder.py — one-time export of the MobileSAM mask DECODER to ONNX.

This is the small model the BROWSER runs (the "light half" of the tap-anything
tool). It is the SAME for every wall, so it's committed into the app at
  public/models/mobile_sam_decoder.onnx
and loaded once (then service-worker cached). The heavy ENCODER runs server-side
in scripts/encode_board_embedding.py to make each wall's embedding.

On a tap the browser feeds the decoder: (image_embeddings, point_coords,
point_labels, mask_input, has_mask_input, orig_im_size) -> (masks, iou, low_res).
We export with --return-single-mask so it emits the model's single best mask
(validated: 24/24 Yonder holds incl. 10/10 smallest traced tightly in the spike).

Run (in the detection venv — see scripts/requirements-detect.txt):
    /tmp/holds_venv/bin/python scripts/export_sam_decoder.py
    # optional: also write a dynamic-quantized copy (~half the size)
    /tmp/holds_venv/bin/python scripts/export_sam_decoder.py --quantize

Deps: torch, segment-anything, samexporter, onnx, onnxruntime (all in the venv).
The checkpoint mobile_sam.pt lives at the repo root (auto-downloaded earlier).
"""
import argparse
import os
import warnings
from pathlib import Path

import torch

warnings.filterwarnings("ignore")
from samexporter.mobile_encoder.setup_mobile_sam import setup_model
from segment_anything.utils.onnx import SamOnnxModel

REPO_ROOT = Path(__file__).resolve().parents[1]


def build_mobile_sam(checkpoint: Path):
    sam = setup_model()
    sam.load_state_dict(torch.load(str(checkpoint), map_location="cpu"), strict=True)
    return sam.cpu().eval()


def export_decoder(sam, out_path: Path, opset: int = 17):
    onnx_model = SamOnnxModel(sam, return_single_mask=True)
    embed_dim = sam.prompt_encoder.embed_dim
    embed_size = sam.prompt_encoder.image_embedding_size
    mask_input_size = [4 * x for x in embed_size]
    dummy = {
        "image_embeddings": torch.randn(1, embed_dim, *embed_size, dtype=torch.float),
        "point_coords": torch.randint(0, 1024, (1, 5, 2)).float(),
        "point_labels": torch.randint(0, 4, (1, 5)).float(),
        "mask_input": torch.randn(1, 1, *mask_input_size, dtype=torch.float),
        "has_mask_input": torch.tensor([1], dtype=torch.float),
        "orig_im_size": torch.tensor([1216, 1990], dtype=torch.float),
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        torch.onnx.export(
            onnx_model, tuple(dummy.values()), str(out_path),
            export_params=True, opset_version=opset, do_constant_folding=True,
            input_names=list(dummy.keys()),
            output_names=["masks", "iou_predictions", "low_res_masks"],
            dynamic_axes={"point_coords": {1: "num_points"},
                          "point_labels": {1: "num_points"}},
        )
    return out_path


def main():
    ap = argparse.ArgumentParser(description="Export the MobileSAM mask decoder to ONNX.")
    ap.add_argument("--checkpoint", default=str(REPO_ROOT / "mobile_sam.pt"))
    ap.add_argument("--output", default=str(REPO_ROOT / "public" / "models" / "mobile_sam_decoder.onnx"))
    ap.add_argument("--opset", type=int, default=17)
    ap.add_argument("--quantize", action="store_true",
                    help="Also write a dynamic-quantized <name>.quant.onnx (~half the size).")
    args = ap.parse_args()

    ckpt = Path(args.checkpoint)
    if not ckpt.exists():
        raise SystemExit(f"Checkpoint not found: {ckpt}")

    print(f"Building MobileSAM from {ckpt.name} ...")
    sam = build_mobile_sam(ckpt)

    out = Path(args.output)
    print(f"Exporting decoder -> {out} (opset {args.opset}) ...")
    export_decoder(sam, out, args.opset)
    print(f"  {out.name}: {out.stat().st_size/1e6:.1f} MB")

    if args.quantize:
        # Optional size optimization. Known to fail on some onnx/onnxruntime
        # version combos (e.g. onnx 1.19) — the fp32 decoder above is the
        # validated, shipped artifact, so we just warn and carry on.
        qout = out.with_suffix(".quant.onnx")
        print(f"Quantizing -> {qout.name} ...")
        try:
            from onnxruntime.quantization import quantize_dynamic, QuantType
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                quantize_dynamic(str(out), str(qout), weight_type=QuantType.QUInt8)
            print(f"  {qout.name}: {qout.stat().st_size/1e6:.1f} MB")
        except Exception as e:
            print(f"  ⚠ quantization skipped ({type(e).__name__}: {e}).")
            print("  Ship the fp32 decoder; revisit quantization if download size matters.")

    print("Done.")


if __name__ == "__main__":
    main()

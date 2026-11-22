#!/usr/bin/env python3
"""
Regression tests for the DXF reader fixes in MMC-BIM-Studio.html.

Each test pins one real defect that was reproduced in a real browser before
being fixed, so a future edit cannot silently bring it back:

  1. Blank lines are legitimate DXF EMPTY VALUES. Dropping them shifted every
     following line and produced bogus "Malformed DXF group code" errors on
     real AutoCAD / Revit / QCAD exports.
  2. Binary DXF ("AutoCAD Binary DXF\\r\\n\\x1a\\x00") must be detected from the
     raw bytes and reported clearly, never parsed as text.
  3. $DWGCODEPAGE must drive text decoding (ANSI_1256 Arabic drawings), and a
     stale legacy codepage must not override genuinely valid UTF-8 bytes.
  4. INSERT arrays (MINSERT), nested blocks, mirrored and non-uniformly scaled
     inserts must be expanded, not silently dropped.
  5. INSUNITS=0 / absent (R12, unitless) must give an actionable message.
  6. CR-only line endings, padded group codes, Y-before-X vertices and a
     missing EOF must all still parse.

Run:  python3 test/dxf_reader_regression.py
It extracts the bundled engine from the HTML and drives it in Node, so it
tests exactly the code the page ships.
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
HTML = os.path.join(ROOT, "MMC-BIM-Studio.html")

PASS, FAIL = [], []


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print(("  PASS  " if ok else "  FAIL  ") + name + (("  -> " + detail) if detail and not ok else ""))


def extract_bundle():
    """Pull the self-contained engine IIFE out of the HTML."""
    src = open(HTML, encoding="utf-8").read()
    start = src.index("(function() {\n  'use strict';\n  const __mods = {};")
    end = src.index("\n})();", start) + len("\n})();")
    return src[start:end]


# ─────────────────────────── fixtures ───────────────────────────
AR = "أعمدة-إنشائي"


def b(s):
    return s.encode("latin1")


def ar_dxf(codepage, layer_bytes, insunits=6):
    h = "0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1015\n9\n$INSUNITS\n70\n%d\n" % insunits
    if codepage:
        h += "9\n$DWGCODEPAGE\n3\n" + codepage + "\n"
    h += "0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nLINE\n8\n"
    e = "\n10\n0\n20\n0\n11\n6\n21\n0\n0\nENDSEC\n0\nEOF\n"
    return b(h) + layer_bytes + b(e)


def block_dxf(insert_extra):
    return b(
        "0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n6\n0\nENDSEC\n"
        "0\nSECTION\n2\nBLOCKS\n0\nBLOCK\n8\n0\n2\nCOL\n70\n0\n10\n0\n20\n0\n30\n0\n"
        "0\nLINE\n8\n0\n10\n0\n20\n0\n11\n0.3\n21\n0\n"
        "0\nLINE\n8\n0\n10\n0.3\n20\n0\n11\n0.3\n21\n0.3\n"
        "0\nENDBLK\n0\nENDSEC\n"
        "0\nSECTION\n2\nENTITIES\n0\nINSERT\n8\nS-COLS\n2\nCOL\n10\n0\n20\n0\n" + insert_extra +
        "0\nENDSEC\n0\nEOF\n"
    )


def fixtures():
    return {
        # 1. blank line as a legitimate empty value ($DIMBLK with no value)
        "blank_value": b(
            "0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1015\n9\n$INSUNITS\n70\n6\n"
            "9\n$DIMBLK\n1\n\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n"
            "0\nLINE\n8\nS-COLS\n10\n0\n20\n0\n11\n6\n21\n0\n0\nENDSEC\n0\nEOF\n"
        ),
        # 2. binary DXF sentinel
        "binary": b("AutoCAD Binary DXF\r\n\x1a\x00") + bytes([0, 0, 83, 69, 67, 84, 73, 79, 78]),
        # 3. codepages
        "cp1256": ar_dxf("ANSI_1256", AR.encode("cp1256")),
        "utf8": ar_dxf("UTF-8", AR.encode("utf-8")),
        "stale": ar_dxf("ANSI_1252", AR.encode("utf-8")),   # UTF-8 bytes, stale codepage
        "nocp": ar_dxf(None, AR.encode("cp1256")),
        # 4. INSERT expansion
        "minsert": block_dxf("70\n3\n71\n1\n44\n1\n45\n0\n"),
        "mirror": block_dxf("41\n-1\n42\n1\n"),
        "nonuniform": block_dxf("41\n2\n42\n1\n"),
        # 5. unitless
        "unitless": b(
            "0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n0\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n"
            "0\nLINE\n8\nS-COLS\n10\n0\n20\n0\n11\n6\n21\n0\n0\nENDSEC\n0\nEOF\n"
        ),
        # 6. tolerant parsing
        "cr_only": b(
            "0\rSECTION\r2\rHEADER\r9\r$INSUNITS\r70\r6\r0\rENDSEC\r0\rSECTION\r2\rENTITIES\r"
            "0\rLINE\r8\rS-COLS\r10\r0\r20\r0\r11\r6\r21\r0\r0\rENDSEC\r0\rEOF\r"
        ),
        "padded": b(
            "  0\nSECTION\n  2\nHEADER\n  9\n$INSUNITS\n 70\n6\n  0\nENDSEC\n  0\nSECTION\n  2\nENTITIES\n"
            "  0\nLINE\n  8\nS-COLS\n 10\n0\n 20\n0\n 11\n6\n 21\n0\n  0\nENDSEC\n  0\nEOF\n"
        ),
        "y_first": b(
            "0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n6\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n"
            "0\nLWPOLYLINE\n8\nA-WALL\n90\n2\n70\n0\n20\n0\n10\n0\n20\n4\n10\n0\n0\nENDSEC\n0\nEOF\n"
        ),
        "no_eof": b(
            "0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n6\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n"
            "0\nLINE\n8\nS-COLS\n10\n0\n20\n0\n11\n6\n21\n0\n0\nENDSEC\n"
        ),
    }


PROBE = r"""
const fs=require('fs'),vm=require('vm');
const ctx={window:{},console,TextDecoder,TextEncoder,Math,Number,String,Object,Array,JSON,Error,Set,Map,isFinite,parseFloat,parseInt};
ctx.globalThis=ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync('bundle.js','utf8'),ctx);
const AI=ctx.window.MmcAi;

// Mirror of the page's decodeDxfBytes (the upload path).
function decodeDxfBytes(buf){
  const bytes=new Uint8Array(buf);
  const sentinel='AutoCAD Binary DXF';
  let isBinary=bytes.length>=sentinel.length;
  for(let i=0;isBinary&&i<sentinel.length;i++){ if(bytes[i]!==sentinel.charCodeAt(i)) isBinary=false; }
  if(isBinary) return {binary:true,text:null,encoding:null};
  const head=new TextDecoder('latin1').decode(bytes.subarray(0,Math.min(bytes.length,65536)));
  const m=/\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*([A-Za-z0-9_]+)/.exec(head);
  const declared=m?m[1]:null;
  let encoding=(AI.codepageToEncoding&&AI.codepageToEncoding(declared))||null;
  let validUtf8=false,hasMultibyte=false;
  try{ new TextDecoder('utf-8',{fatal:true}).decode(bytes); validUtf8=true;
       for(let i=0;i<bytes.length;i++){ if(bytes[i]>=0x80){hasMultibyte=true;break;} } }catch(_){}
  if(validUtf8&&hasMultibyte&&encoding!=='utf-8') encoding='utf-8';
  if(!encoding) encoding=validUtf8?'utf-8':'windows-1256';
  let text; try{ text=new TextDecoder(encoding).decode(bytes); }catch(_){ text=new TextDecoder('utf-8').decode(bytes); encoding='utf-8'; }
  return {binary:false,text,encoding,declared};
}

function takeoff(name){
  const d=decodeDxfBytes(fs.readFileSync('fx/'+name+'.dxf'));
  if(d.binary) return {binary:true};
  try{ const t=AI.takeoffDxf(d.text,{});
       return {rows:t.rows.length,unsupported:t.unsupported,encoding:d.encoding,declared:d.declared,
               layers:[...new Set(t.rows.map(r=>r.layer))]}; }
  catch(e){ return {error:e.message,encoding:d.encoding,declared:d.declared}; }
}

const out={};
for(const n of fs.readdirSync('fx')) out[n.replace('.dxf','')]=takeoff(n.replace('.dxf',''));
console.log(JSON.stringify(out));
"""


def run_node(bundle, fx):
    with tempfile.TemporaryDirectory() as d:
        open(os.path.join(d, "bundle.js"), "w", encoding="utf-8").write(bundle)
        open(os.path.join(d, "probe.js"), "w", encoding="utf-8").write(PROBE)
        os.mkdir(os.path.join(d, "fx"))
        for name, data in fx.items():
            open(os.path.join(d, "fx", name + ".dxf"), "wb").write(data)
        r = subprocess.run(["node", "probe.js"], cwd=d, capture_output=True, text=True, timeout=180)
        if r.returncode != 0:
            raise RuntimeError(r.stderr[-2000:])
        return json.loads(r.stdout)


def main():
    if not os.path.exists(HTML):
        print("MMC-BIM-Studio.html not found next to test/")
        return 1
    print("Extracting engine from MMC-BIM-Studio.html ...")
    bundle = extract_bundle()
    print("Running probes in Node ...\n")
    r = run_node(bundle, fixtures())

    print("1. Blank line as a legitimate empty value")
    check("blank value does not break parsing", "error" not in r["blank_value"], str(r["blank_value"].get("error")))
    check("blank value still yields the LINE", r["blank_value"].get("rows") == 1, str(r["blank_value"]))

    print("\n2. Binary DXF")
    check("binary DXF detected from raw bytes", r["binary"].get("binary") is True, str(r["binary"]))

    print("\n3. Text encoding / $DWGCODEPAGE")
    for k, label in [("cp1256", "ANSI_1256 (cp1256) decoded correctly"),
                     ("utf8", "UTF-8 with UTF-8 codepage"),
                     ("stale", "stale ANSI_1252 does not override valid UTF-8"),
                     ("nocp", "no codepage falls back to cp1256")]:
        v = r[k]
        ok = v.get("rows") == 1 and AR in (v.get("layers") or [])
        check(label, ok, str(v))

    print("\n4. INSERT expansion")
    # The test block holds 2 LINEs, so one instance yields 2 rows.
    check("MINSERT array expands to 3 instances (6 rows)", r["minsert"].get("rows") == 6, str(r["minsert"]))
    check("mirrored INSERT expands (2 rows)", r["mirror"].get("rows") == 2, str(r["mirror"]))
    check("non-uniform INSERT expands (2 rows)", r["nonuniform"].get("rows") == 2, str(r["nonuniform"]))

    print("\n5. Undefined units")
    check("unitless gives UNITS_UNDEFINED",
          str(r["unitless"].get("error", "")).startswith("UNITS_UNDEFINED"), str(r["unitless"]))

    print("\n6. Tolerant parsing")
    check("CR-only line endings", r["cr_only"].get("rows") == 1, str(r["cr_only"]))
    check("padded group codes", r["padded"].get("rows") == 1, str(r["padded"]))
    check("Y-before-X vertices", r["y_first"].get("rows") == 1, str(r["y_first"]))
    check("missing EOF", r["no_eof"].get("rows") == 1, str(r["no_eof"]))

    print("\n" + "=" * 60)
    print("PASSED: %d   FAILED: %d" % (len(PASS), len(FAIL)))
    if FAIL:
        print("Failures:")
        for f in FAIL:
            print("  - " + f)
        return 1
    print("All DXF reader regression tests passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

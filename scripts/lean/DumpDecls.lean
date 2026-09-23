/-
  DumpDecls — export theorem statements from an imported environment as
  JSON lines, for the premise-retrieval index (`scripts/build-premise-index.ts`).

  Run from the sandbox project so that Mathlib's oleans are on the search path:

    cd lean-sandbox
    lake env lean --run ../scripts/lean/DumpDecls.lean \
      --import Mathlib --prefix Mathlib.Algebra --prefix Mathlib.Data.Nat > decls.jsonl

  Options:
    --import <Module>   module(s) to import (default: Mathlib)
    --prefix <Module>   only declarations defined in modules with this prefix
                        (repeatable; default: every imported module)
    --defs              also export definitions (names + types), not only theorems
    --max <n>           stop after n declarations (0 = no limit)

  One JSON object per line: {"n": name, "t": type, "m": module, "k": "thm" | "def"}.
  Internal / auxiliary declarations (`_private`, `proof_1`, `match_1`, `eq_1`,
  recursors, instances, …) are skipped.
-/
import Lean
open Lean Meta

structure DumpOpts where
  imports : Array Name := #[]
  prefixes : Array String := #[]
  defs : Bool := false
  max : Nat := 0

partial def parseArgs : List String → DumpOpts → DumpOpts
  | "--import" :: m :: rest, o => parseArgs rest { o with imports := o.imports.push m.toName }
  | "--prefix" :: p :: rest, o => parseArgs rest { o with prefixes := o.prefixes.push p }
  | "--defs" :: rest, o => parseArgs rest { o with defs := true }
  | "--max" :: n :: rest, o => parseArgs rest { o with max := n.toNat! }
  | _ :: rest, o => parseArgs rest o
  | [], o => o

/-- Name components that mark compiler- or tactic-generated declarations. -/
def junkComponent (s : String) : Bool :=
  s.startsWith "_" || s.startsWith "proof_" || s.startsWith "match_" || s.startsWith "eq_" ||
  s.startsWith "inst" || s.startsWith "aux_" || s.endsWith "_aux" || s.startsWith "casesOn" ||
  s == "rec" || s == "recOn" || s == "brecOn" || s == "binductionOn" || s == "below" ||
  s == "ibelow" || s == "noConfusion" || s == "noConfusionType" || s == "sizeOf_spec" ||
  s == "injEq" || s == "inj" || s == "mk.injEq" || s == "ofNat_eq" || s.startsWith "proof" ||
  s.startsWith "spec_" || s.endsWith "_spec" && s.startsWith "_" || s.startsWith "simps"

def isJunk (n : Name) : Bool :=
  n.isInternal || n.components.any fun c =>
    match c with
    | .str _ s => junkComponent s
    | .num _ _ => true
    | .anonymous => false

def moduleOf (env : Environment) (n : Name) : String :=
  match env.getModuleIdxFor? n with
  | some idx => (env.header.moduleNames[idx.toNat]!).toString
  | none => ""

def inPrefixes (prefixes : Array String) (m : String) : Bool :=
  prefixes.isEmpty || prefixes.any fun p => m == p || m.startsWith (p ++ ".")

def jsonStr (s : String) : String := (Json.str s).compress

/-- Collapse runs of whitespace (pretty-printer line breaks) into single spaces. -/
def collapseWs (s : String) : String := Id.run do
  let mut out := ""
  let mut prevWs := true
  for c in s.toList do
    if c.isWhitespace then
      if !prevWs then out := out.push ' '
      prevWs := true
    else
      out := out.push c
      prevWs := false
  return if out.endsWith " " then out.dropRight 1 else out

def dump (o : DumpOpts) : MetaM Unit := do
  let env ← getEnv
  let mut count := 0
  let out ← IO.getStdout
  for (n, ci) in env.constants.map₁.toList do
    if o.max > 0 && count ≥ o.max then break
    if isJunk n then continue
    let kind ← match ci with
      | .thmInfo _ => pure "thm"
      | .defnInfo _ => do
          if !o.defs then continue
          -- skip instances and Prop-valued auxiliaries
          if (← isInstance n) then continue
          pure "def"
      | _ => continue
    let m := moduleOf env n
    if !inPrefixes o.prefixes m then continue
    let ty ← try
        let fmt ← withOptions (fun opts => opts.setBool `pp.universes false) <| ppExpr ci.type
        pure (fmt.pretty 100000)
      catch _ => continue
    let ty := collapseWs ty
    if ty.length > 1200 then continue
    out.putStrLn s!"\{\"n\":{jsonStr n.toString},\"t\":{jsonStr ty},\"m\":{jsonStr m},\"k\":\"{kind}\"}"
    count := count + 1
  IO.eprintln s!"dumped {count} declarations"

unsafe def main (args : List String) : IO Unit := do
  let o := parseArgs args {}
  let o := if o.imports.isEmpty then { o with imports := #[`Mathlib] } else o
  initSearchPath (← findSysroot)
  enableInitializersExecution
  let env ← importModules (o.imports.map fun m => { module := m }) {} (trustLevel := 0) (loadExts := true)
  let ctx : Core.Context := { fileName := "<DumpDecls>", fileMap := default }
  let _ ← (dump o).toIO ctx { env }

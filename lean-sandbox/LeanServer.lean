-- Persistent Lean 4 verification server.
-- Reads JSON-line commands from stdin, writes JSON-line responses to stdout.
-- Commands: {"cmd": "verify", "path": "..."} or {"cmd": "quit"}
-- Response: {"ok": bool, "messages": [{"severity": "...", "pos": {...}, "data": "..."}]}
import Lean
import Batteries
import Aesop

open Lean System IO.FS

/-- Format a Message into a JSON-compatible structure. -/
def messageToJSON (msg : Lean.Message) : IO (Lean.Json) := do
  let pos := msg.pos
  let endPos := msg.endPos.getD pos
  let severity : String := match msg.severity with
    | .error => "error"
    | .warning => "warning"
    | .information => "info"
  let text ← msg.data.toString
  return Lean.Json.mkObj [
    ("severity", severity),
    ("line", pos.line),
    ("column", pos.column),
    ("endLine", endPos.line),
    ("endColumn", endPos.column),
    ("data", text.trimAscii.copy)
  ]

/-- Check a Lean source file and return JSON result. -/
unsafe def checkFile (filePath : String) : IO (Lean.Json) := do
  let path := System.FilePath.mk filePath
  let source ← IO.FS.readFile path
  let inputCtx := Parser.mkInputContext source filePath
  -- Parse header to get imports and parser state after header
  let (header, parserState, headerMsgs) ← Parser.parseHeader inputCtx
  -- Create environment with the file's imports (includes implicit Init)
  -- loadExts := true is critical — it runs module initializers that register
  -- notations (e.g. `+`), elab handlers, and other parser extensions.
  -- enableInitializersExecution is required before importModules with loadExts.
  let imports := Elab.headerToImports header
  enableInitializersExecution
  let env ← importModules (loadExts := true) imports (opts := {}) (trustLevel := 1024)
  -- Process commands starting after the header
  let cmdState := Elab.Command.mkState env headerMsgs {}
  let s ← Elab.IO.processCommands inputCtx parserState cmdState
  let messages := s.commandState.messages
  let msgArray ← messages.toArray.mapM messageToJSON
  let ok := !messages.hasErrors
  return Lean.Json.mkObj [
    ("ok", ok),
    ("messages", Lean.Json.arr msgArray)
  ]

/-- Main loop: read JSON commands from stdin, write JSON responses to stdout. -/
unsafe def mainLoop : IO Unit := do
  let stdin ← IO.getStdin
  let stdout ← IO.getStdout
  let line ← stdin.getLine
  if line.isEmpty then
    return  -- EOF
  let trimmed := line.trimAscii.copy
  if trimmed.isEmpty then
    mainLoop  -- skip empty lines
  else
    let response ← do
      match Lean.Json.parse trimmed with
      | .error e =>
        pure <| Lean.Json.mkObj [("error", s!"JSON parse error: {e}")]
      | .ok json =>
        match json.getObjValAs? String "cmd" with
        | .ok "verify" =>
          match json.getObjValAs? String "path" with
          | .ok path =>
            try
              checkFile path
            catch e =>
              pure <| Lean.Json.mkObj [
                ("ok", Json.bool false),
                ("messages", Lean.Json.arr #[
                  Lean.Json.mkObj [("severity", "error"), ("data", s!"IO error: {e}")]
                ])
              ]
          | .error e =>
            pure <| Lean.Json.mkObj [("error", s!"missing 'path': {e}")]
        | .ok "quit" =>
          pure <| Lean.Json.mkObj [("status", "bye")]
        | .ok cmd =>
          pure <| Lean.Json.mkObj [("error", s!"unknown command: {cmd}")]
        | .error e =>
          pure <| Lean.Json.mkObj [("error", s!"missing 'cmd': {e}")]
    stdout.putStrLn (toString response)
    stdout.flush
    -- Continue loop unless quit was received
    match response.getObjValAs? String "status" with
    | .ok "bye" => return
    | _ => mainLoop

unsafe def main : IO Unit := do
  -- Initialize search path: toolchain lib dir + LEAN_PATH entries.
  -- LEAN_PATH alone only contains package build dirs and misses the
  -- toolchain's standard library (Init.olean, Std.olean, Lean.olean).
  Lean.initSearchPath (← Lean.findSysroot)
  let stdout ← IO.getStdout
  -- Signal that server is ready
  stdout.putStrLn (toString (Lean.Json.mkObj [("status", "ready")]))
  stdout.flush
  mainLoop

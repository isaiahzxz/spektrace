import { execFileSync } from "node:child_process";
import { open, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function assertPrivateParent(parent: string): Promise<string | null> {
  const home = await realpath(os.homedir());
  const relative = path.relative(home, parent);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Secret directory must be inside the current user profile");
  if (process.platform === "win32") {
    const script = `$ErrorActionPreference='Stop'; $p='${parent.replaceAll("'", "''")}'; $homePath='${home.replaceAll("'", "''")}';
      $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
      $trusted=@($sid,'S-1-5-18','S-1-5-32-544');
      while ($true) {
        $acl=[System.IO.Directory]::GetAccessControl($p);
        $owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;
        if ($trusted -notcontains $owner) { throw 'Untrusted directory owner' };
        foreach($entry in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {
          if ($entry.AccessControlType -eq 'Allow' -and (([long]$entry.FileSystemRights -band 852310) -ne 0) -and ($trusted -notcontains $entry.IdentityReference.Value)) { throw 'Directory permits other writers' }
        };
        if ($p -eq $homePath) { break }; $p=[System.IO.Directory]::GetParent($p).FullName
      }; Write-Output $sid`;
    const sid = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (!/^S-1-5-\d+(?:-\d+)+$/.test(sid)) throw new Error("Cannot verify private directory");
    return sid;
  }
  let current = parent;
  while (true) {
    const info = await stat(current);
    if (info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0) throw new Error("Directory permits other writers");
    if (current === home) break;
    current = path.dirname(current);
  }
  return null;
}

export async function writeCredentialSecretFile(filename: string, material: { id: string; token: string }) {
  if (!path.isAbsolute(filename)) throw new Error("Secret file must use an absolute path");
  const parent = await realpath(path.dirname(filename));
  const repo = await realpath(process.cwd());
  const relative = path.relative(repo, parent);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    throw new Error("Secret file must be outside the repository");
  }
  const sid = await assertPrivateParent(parent);
  const target = path.join(parent, path.basename(filename));
  const file = await open(target, "wx", 0o600);
  try {
    if (process.platform === "win32") {
      if (!sid) throw new Error("Cannot determine private file owner");
      // The file is still empty while inherited access is removed.
      execFileSync("icacls", [target, "/inheritance:r", "/grant:r", `*${sid}:(F)`], { stdio: "pipe", windowsHide: true });
    } else {
      await file.chmod(0o600);
    }
    await file.writeFile(`${JSON.stringify({ credentialId: material.id, token: material.token })}\n`, "utf8");
    await file.sync();
  } finally { await file.close(); }
}

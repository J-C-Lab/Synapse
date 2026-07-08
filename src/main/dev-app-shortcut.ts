import { existsSync } from "node:fs"
import * as path from "node:path"
import process from "node:process"
import { app } from "electron"
import { logger } from "./logging"

const SHORTCUT_NAME = "Synapse (Dev).lnk"
const AUMID = "com.synapse.desktop"

/** Start Menu path for the dev-only shortcut, given `%APPDATA%`. */
export function devShortcutPath(appDataDir: string): string {
  return path.join(appDataDir, "Microsoft", "Windows", "Start Menu", "Programs", SHORTCUT_NAME)
}

interface ShortcutScriptOptions {
  shortcutPath: string
  targetExe: string
  appDir: string
  iconPath: string
  aumid: string
}

/**
 * PowerShell script that (1) creates a `.lnk` via the standard WScript.Shell
 * automation object, then (2) stamps `System.AppUserModel.ID` on it via
 * IPropertyStore COM interop — WScript.Shell has no AUMID property, so this
 * second step is the well-established way to set it from PowerShell without
 * a native module. Windows resolves a toast notification's displayed name
 * and icon from the Start Menu shortcut registered for the running
 * process's AUMID; without a matching shortcut, it falls back to showing
 * the raw AUMID string, which is the bug this fixes in `pnpm dev`.
 */
export function buildShortcutScript(opts: ShortcutScriptOptions): string {
  return `
$ErrorActionPreference = "Stop"

$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut("${opts.shortcutPath}")
$Shortcut.TargetPath = "${opts.targetExe}"
$Shortcut.WorkingDirectory = "${opts.appDir}"
$Shortcut.IconLocation = "${opts.iconPath}"
$Shortcut.Save()

Add-Type @"
using System;
using System.Runtime.InteropServices;

public struct PROPERTYKEY {
    public Guid fmtid;
    public int pid;
}

[StructLayout(LayoutKind.Sequential)]
public struct PROPVARIANT {
    public ushort vt;
    public ushort wReserved1, wReserved2, wReserved3;
    public IntPtr p;
    public int p2;
}

[ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPropertyStore {
    int GetCount(out uint cProps);
    int GetAt(uint iProp, out PROPERTYKEY pkey);
    int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
    int SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
    int Commit();
}

[ComImport, Guid("00021401-0000-0000-C000-000000000046")]
public class CShellLink { }

[ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IShellLinkW {
    int GetPath([Out] char[] pszFile, int cchMaxPath, IntPtr pfd, uint fFlags);
    int GetIDList(out IntPtr ppidl);
    int SetIDList(IntPtr pidl);
    int GetDescription([Out] char[] pszName, int cchMaxName);
    int SetDescription(string pszName);
    int GetWorkingDirectory([Out] char[] pszDir, int cchMaxPath);
    int SetWorkingDirectory(string pszDir);
    int GetArguments([Out] char[] pszArgs, int cchMaxPath);
    int SetArguments(string pszArgs);
    int GetHotkey(out short wHotkey);
    int SetHotkey(short wHotkey);
    int GetShowCmd(out int iShowCmd);
    int SetShowCmd(int iShowCmd);
    int GetIconLocation([Out] char[] pszIconPath, int cchIconPath, out int iIcon);
    int SetIconLocation(string pszIconPath, int iIcon);
    int SetRelativePath(string pszPathRel, uint dwReserved);
    int Resolve(IntPtr hwnd, uint fFlags);
    int SetPath(string pszFile);
}

public static class AumidStamper {
    public static void Stamp(string shortcutPath, string aumid) {
        var link = (IShellLinkW)new CShellLink();
        var persistFile = (System.Runtime.InteropServices.ComTypes.IPersistFile)link;
        persistFile.Load(shortcutPath, 2); // STGM_READWRITE — required to Commit() and Save()

        var store = (IPropertyStore)link;
        var key = new PROPERTYKEY { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
        var value = new PROPVARIANT { vt = 31 /* VT_LPWSTR */, p = Marshal.StringToCoTaskMemUni(aumid) };
        store.SetValue(ref key, ref value);
        store.Commit();
        persistFile.Save(shortcutPath, true);
        Marshal.FreeCoTaskMem(value.p);
    }
}
"@ -ReferencedAssemblies System.Runtime.InteropServices

[AumidStamper]::Stamp("${opts.shortcutPath}", "${opts.aumid}")
`.trim()
}

/**
 * Dev-only convenience: without an installed Start Menu shortcut, Windows
 * shows the raw AUMID instead of "Synapse" + the app icon on the startup
 * toast. Creates one once per machine; safe to call on every launch since
 * it's a no-op after the first successful run. Never throws — a failure
 * here must not block app startup.
 */
export async function ensureDevAppUserModelShortcut(): Promise<void> {
  if (app.isPackaged || process.platform !== "win32") return

  const appData = process.env.APPDATA
  if (!appData) return
  const shortcutPath = devShortcutPath(appData)
  if (existsSync(shortcutPath)) return

  const script = buildShortcutScript({
    shortcutPath,
    targetExe: process.execPath,
    appDir: app.getAppPath(),
    iconPath: path.join(app.getAppPath(), "resources", "icon.ico"),
    aumid: AUMID,
  })

  const { execFile } = await import("node:child_process")
  await new Promise<void>((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], (err) => {
      if (err) {
        logger
          .child("synapse")
          .warn("failed to create dev Start Menu shortcut for toast identity", { err })
      }
      resolve()
    })
  })
}

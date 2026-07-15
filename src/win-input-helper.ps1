# Low-level keyboard + mouse hook helper for Stealth Chat.
# Runs as a separate process so the hooks own a real Win32 message loop.
# Protocol (line-based):
#   stdin :  CAP 1 | CAP 0 | RECT <x> <y> <w> <h> | QUIT
#   stdout:  READY | STATE 1 | STATE 0 | CHAR <hex...> | KEY <NAME>
# While "capturing", keystrokes are SWALLOWED (never reach the active app)
# and reported here instead; the underlying window keeps its focus.

$ErrorActionPreference = 'Stop'

$code = @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public class StealthHook {
  delegate IntPtr LLProc(int nCode, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll", SetLastError=true)]
  static extern IntPtr SetWindowsHookEx(int idHook, LLProc lpfn, IntPtr hMod, uint dwThreadId);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hhk);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
  [DllImport("kernel32.dll", CharSet=CharSet.Auto)] static extern IntPtr GetModuleHandle(string name);
  [DllImport("user32.dll")] static extern int ToUnicodeEx(uint wVirtKey, uint wScanCode, byte[] lpKeyState, StringBuilder pwszBuff, int cchBuff, uint wFlags, IntPtr dwhkl);
  [DllImport("user32.dll")] static extern IntPtr GetKeyboardLayout(uint idThread);
  [DllImport("user32.dll")] static extern short GetKeyState(int nVirtKey);

  const int WH_KEYBOARD_LL=13, WH_MOUSE_LL=14;
  const int WM_KEYDOWN=0x100, WM_SYSKEYDOWN=0x104, WM_KEYUP=0x101, WM_SYSKEYUP=0x105;
  const int WM_LBUTTONDOWN=0x201, WM_RBUTTONDOWN=0x204;

  static IntPtr kbHook, msHook;
  static LLProc kbProc, msProc;         // keep alive
  static volatile bool capturing=false;
  static int rx, ry, rw, rh;            // window rect (physical px)
  static bool shift=false, ctrl=false, alt=false, caps=false;
  static IntPtr hkl;
  static readonly object outLock=new object();

  [StructLayout(LayoutKind.Sequential)]
  struct KBD { public uint vk; public uint sc; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)]
  struct MSL { public int x; public int y; public uint data; public uint flags; public uint time; public IntPtr extra; }

  static void Emit(string s){ lock(outLock){ Console.Out.WriteLine(s); Console.Out.Flush(); } }

  static IntPtr KbCallback(int nCode, IntPtr wParam, IntPtr lParam){
    try {
      if(nCode>=0 && capturing){
        int msg=(int)wParam;
        KBD k=(KBD)Marshal.PtrToStructure(lParam, typeof(KBD));
        bool down=(msg==WM_KEYDOWN||msg==WM_SYSKEYDOWN);
        uint vk=k.vk;
        if(vk==0x10||vk==0xA0||vk==0xA1){ shift=down; return (IntPtr)1; }
        if(vk==0x11||vk==0xA2||vk==0xA3){ ctrl=down;  return (IntPtr)1; }
        if(vk==0x12||vk==0xA4||vk==0xA5){ alt=down;   return (IntPtr)1; }
        if(vk==0x14){ if(down) caps=!caps; return (IntPtr)1; }
        if(down){
          if(ctrl && vk==0x56){ Emit("KEY PASTE"); return (IntPtr)1; }
          if(ctrl && vk==0x43){ Emit("KEY COPY"); return (IntPtr)1; }
          if(ctrl){ return (IntPtr)1; }
          if(vk==0x08){ Emit("KEY BACKSPACE"); return (IntPtr)1; }
          if(vk==0x0D){ Emit(shift ? "KEY SHIFTENTER" : "KEY ENTER"); return (IntPtr)1; }
          if(vk==0x1B){ capturing=false; Emit("KEY ESCAPE"); Emit("STATE 0"); return (IntPtr)1; }
          if(vk==0x09){ return (IntPtr)1; }
          byte[] ks=new byte[256];
          if(shift) ks[0x10]=0x80;
          if(caps)  ks[0x14]=0x01;
          StringBuilder sb=new StringBuilder(8);
          int n=ToUnicodeEx(vk, k.sc, ks, sb, sb.Capacity, 0, hkl);
          if(n>0){
            string s=sb.ToString(0, n);
            StringBuilder hex=new StringBuilder();
            foreach(char c in s){ hex.Append(((int)c).ToString("X4")); hex.Append(' '); }
            Emit("CHAR "+hex.ToString().Trim());
          }
          return (IntPtr)1;
        }
        return (IntPtr)1; // swallow key-up too
      }
    } catch {}
    return CallNextHookEx(kbHook, nCode, wParam, lParam);
  }

  static IntPtr MsCallback(int nCode, IntPtr wParam, IntPtr lParam){
    try {
      if(nCode>=0){
        int msg=(int)wParam;
        if(msg==WM_LBUTTONDOWN || msg==WM_RBUTTONDOWN){
          // Only RELEASE on a click fully outside our window. Grabbing the
          // keyboard is decided by the renderer (a click on the prompt input
          // bar), so title bar / buttons / resize / sidebar never grab it.
          MSL m=(MSL)Marshal.PtrToStructure(lParam, typeof(MSL));
          bool inside=(m.x>=rx && m.x<rx+rw && m.y>=ry && m.y<ry+rh);
          if(!inside && capturing){ capturing=false; Emit("STATE 0"); }
        }
      }
    } catch {}
    return CallNextHookEx(msHook, nCode, wParam, lParam);
  }

  static void StdinLoop(){
    try {
      string line;
      while((line=Console.In.ReadLine())!=null){
        string[] p=line.Trim().Split(' ');
        if(p[0]=="CAP"){
          capturing=(p.Length>1 && p[1]=="1");
          if(capturing){ shift=false; ctrl=false; alt=false; caps=(GetKeyState(0x14)&1)!=0; }
          Emit("STATE "+(capturing?"1":"0"));
        } else if(p[0]=="RECT" && p.Length>=5){
          rx=int.Parse(p[1]); ry=int.Parse(p[2]); rw=int.Parse(p[3]); rh=int.Parse(p[4]);
        } else if(p[0]=="QUIT"){ Cleanup(); Environment.Exit(0); }
      }
    } catch {}
    Cleanup(); Environment.Exit(0);
  }

  static void Cleanup(){
    if(kbHook!=IntPtr.Zero) UnhookWindowsHookEx(kbHook);
    if(msHook!=IntPtr.Zero) UnhookWindowsHookEx(msHook);
  }

  public static void Run(){
    hkl=GetKeyboardLayout(0);
    kbProc=KbCallback; msProc=MsCallback;
    IntPtr hMod;
    using(Process pr=Process.GetCurrentProcess())
    using(ProcessModule mod=pr.MainModule){ hMod=GetModuleHandle(mod.ModuleName); }
    kbHook=SetWindowsHookEx(WH_KEYBOARD_LL, kbProc, hMod, 0);
    msHook=SetWindowsHookEx(WH_MOUSE_LL,   msProc, hMod, 0);
    if(kbHook==IntPtr.Zero){ Emit("ERR keyboard-hook-failed"); Environment.Exit(2); }
    Emit("READY");
    Thread t=new Thread(StdinLoop); t.IsBackground=true; t.Start();
    Application.Run();
  }
}
'@

Add-Type -TypeDefinition $code -ReferencedAssemblies 'System.Windows.Forms','System.Drawing' -Language CSharp
[StealthHook]::Run()

param(
    [Parameter(Mandatory=$true)]
    [ValidateSet('list-windows','capture-window','capture-screen','capture-region')]
    [string]$Action,

    [string]$Handle = '',
    [string]$Output = ''
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Drawing;
using System.Drawing.Imaging;
using System.Text;
using System.Collections.Generic;

public class ScreenCapture {
    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);

    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();

    [DllImport("dwmapi.dll")]
    static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);

    [DllImport("user32.dll")]
    static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    const int GWL_EXSTYLE = -20;
    const int WS_EX_TOOLWINDOW = 0x00000080;
    const int WS_EX_NOACTIVATE = 0x08000000;
    const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;

    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left, Top, Right, Bottom;
    }

    public class WindowInfo {
        public IntPtr Handle;
        public string Title;
        public string ProcessName;
        public int Width;
        public int Height;
    }

    public static List<WindowInfo> ListWindows() {
        var windows = new List<WindowInfo>();
        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            if (IsIconic(hWnd)) return true;

            int exStyle = GetWindowLong(hWnd, GWL_EXSTYLE);
            if ((exStyle & WS_EX_TOOLWINDOW) != 0) return true;

            int len = GetWindowTextLength(hWnd);
            if (len == 0) return true;

            var sb = new StringBuilder(len + 1);
            GetWindowText(hWnd, sb, sb.Capacity);
            string title = sb.ToString();
            if (string.IsNullOrWhiteSpace(title)) return true;

            RECT rect;
            DwmGetWindowAttribute(hWnd, DWMWA_EXTENDED_FRAME_BOUNDS, out rect, Marshal.SizeOf(typeof(RECT)));
            int w = rect.Right - rect.Left;
            int h = rect.Bottom - rect.Top;
            if (w < 100 || h < 50) return true;

            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            string procName = "";
            try { procName = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch {}

            windows.Add(new WindowInfo {
                Handle = hWnd,
                Title = title,
                ProcessName = procName,
                Width = w,
                Height = h
            });
            return true;
        }, IntPtr.Zero);
        return windows;
    }

    public static Bitmap CaptureWindow(IntPtr hWnd) {
        RECT rect;
        DwmGetWindowAttribute(hWnd, DWMWA_EXTENDED_FRAME_BOUNDS, out rect, Marshal.SizeOf(typeof(RECT)));
        int w = rect.Right - rect.Left;
        int h = rect.Bottom - rect.Top;
        if (w <= 0 || h <= 0) return null;

        var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp)) {
            g.CopyFromScreen(rect.Left, rect.Top, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
        }
        return bmp;
    }

    public static Bitmap CaptureScreen() {
        var bounds = System.Windows.Forms.Screen.PrimaryScreen.Bounds;
        var bmp = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp)) {
            g.CopyFromScreen(bounds.Left, bounds.Top, 0, 0, bounds.Size, CopyPixelOperation.SourceCopy);
        }
        return bmp;
    }

    public static string ThumbnailBase64(IntPtr hWnd, int maxW, int maxH) {
        var bmp = CaptureWindow(hWnd);
        if (bmp == null) return "";

        float scale = Math.Min((float)maxW / bmp.Width, (float)maxH / bmp.Height);
        int tw = (int)(bmp.Width * scale);
        int th = (int)(bmp.Height * scale);

        var thumb = new Bitmap(tw, th);
        using (var g = Graphics.FromImage(thumb)) {
            g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
            g.DrawImage(bmp, 0, 0, tw, th);
        }
        bmp.Dispose();

        using (var ms = new System.IO.MemoryStream()) {
            thumb.Save(ms, ImageFormat.Jpeg);
            thumb.Dispose();
            return Convert.ToBase64String(ms.ToArray());
        }
    }
}
"@ -ReferencedAssemblies System.Drawing, System.Windows.Forms

if ($Action -eq 'list-windows') {
    $windows = [ScreenCapture]::ListWindows()
    $result = @()
    foreach ($w in $windows) {
        $thumb = [ScreenCapture]::ThumbnailBase64($w.Handle, 240, 160)
        $result += @{
            handle = $w.Handle.ToInt64()
            title = $w.Title
            process = $w.ProcessName
            width = $w.Width
            height = $w.Height
            thumbnail = $thumb
        }
    }
    $result | ConvertTo-Json -Depth 3
}
elseif ($Action -eq 'capture-window') {
    if (-not $Handle) { Write-Error "Handle required"; exit 1 }
    $hWnd = [IntPtr]::new([long]$Handle)
    $bmp = [ScreenCapture]::CaptureWindow($hWnd)
    if ($bmp) {
        $bmp.Save($Output, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        Write-Output $Output
    }
}
elseif ($Action -eq 'capture-screen') {
    $bmp = [ScreenCapture]::CaptureScreen()
    $bmp.Save($Output, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output $Output
}
elseif ($Action -eq 'capture-region') {
    # Full screen capture, return path — client does the cropping
    $bmp = [ScreenCapture]::CaptureScreen()
    $bmp.Save($Output, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output $Output
}

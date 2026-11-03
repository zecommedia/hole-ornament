<#
.SYNOPSIS
    Tach nen trang khoi anh clipart -> PNG trong suot.

.DESCRIPTION
    Thuat toan co dien 4 buoc:
      1. Uoc luong mau nen tu vien anh
      2. Flood-fill tu mep anh -> tim dung vung nen that
         (vung trang NAM TRONG vat the se KHONG bi an, vi khong loang toi duoc)
      3. Alpha mem o dai bien -> khong rang cua
      4. Khu vien trang (decontamination) -> khong quang trang khi in len vai toi mau

.EXAMPLE
    .\Remove-WhiteBg.ps1 -Path "anh.jpeg"
    .\Remove-WhiteBg.ps1 -Path "D:\clipart" -TLow 6 -THigh 14
#>
[CmdletBinding()]
param(
    # File anh, hoac thu muc chua anh
    [Parameter(Mandatory)] [string] $Path,

    # Thu muc xuat (mac dinh: <thu muc nguon>\output)
    [string] $OutDir,

    # Nguong "chac chan la nen". Tang len neu con vien trang sot lai.
    [int] $TLow = 6,

    # Nguong "chac chan la vat the". Giam neu bien bi rang cua; TANG neu chi tiet mo bi an mat.
    [int] $THigh = 16,

    # --- Luat duc LO KIN (vung sang bi vat the bao quanh) ---
    # Duc thung neu vung do DU PHANG (dung mau nen, khong bien thien).
    [double] $HoleMaxMean = 6.0,
    [double] $HoleMaxStd  = 6.0,
    [int]    $HoleMinArea = 60,

    # Do day toi da cua "vo" bao quanh lo (px). Lo THAT nam trong chi tiet manh
    # (thanh ong, nan hoa, quai) nen vo mong. Hoa tiet trang cua ban ve (chu,
    # nhan, logo) nam sau trong khoi dac nen vo day -> khong duc.
    [double] $HoleMaxShell = 120,

    # --- VIEN bao quanh kieu die-cut sticker ---
    # Do rong vien tinh bang mm. 0 = khong ve vien.
    [double] $OutlineMm = 0,

    # Do phan giai in, dung de quy doi mm -> pixel. Chuan POD la 300.
    [double] $Dpi = 300,

    # Dat truc tiep ban kinh vien bang pixel; neu >0 se ghi de OutlineMm/Dpi
    [double] $OutlinePx = 0,

    # Mau vien
    [string] $OutlineColor = 'White',

    # Do min cua vien: tinh o do phan giai gap N lan roi ha xuong.
    # 1 = nhanh nhat nhung vien bi bac thang. 3 = mac dinh. 4 = min nhat, ton RAM.
    [ValidateRange(1,4)] [int] $OutlineQuality = 3,

    # --- BIEN vat the (khu rang cua hinh hoc) ---
    # Ban kinh lam muot duong bien (px). Cao hon = bien tron tru hon,
    # nhung chi tiet manh (soi chi) se bi gam bot.
    [ValidateRange(0,4)] [double] $Smooth = 1.0,

    # Diem giua cua doc alpha tren truong bien. 0.5 = trung tinh.
    # Cao hon = keo bien VAO TRONG vat the (bot rim trang sot lai).
    [ValidateRange(0.3,0.7)] [double] $EdgeMid = 0.52,

    # Xoa cum "vat the" tach roi nho hon N px (thuong la vun nhieu JPEG). 0 = tat.
    [int] $MinIsland = 24,

    # Be rong dai khu rang cua, tinh bang PIXEL. Anh clipart AI thuong co bien
    # mem san 3-4px; dat qua hep (<1.5) se lo bac thang, qua rong se nhoe.
    [double] $EdgeSoft = 3.5,

    # Dang doc alpha: 0 = doc thang (co goc gay o hai dau dai), 1 = smoothstep
    # (vai mem hai dau, doc o giua - giong bien mem tu nhien cua ban ve).
    [ValidateRange(0,1)] [double] $Smoothstep = 1.0,

    # Muc do xu ly (xem tien trinh qua tung "round" kiem dinh):
    # 1 = alpha hinh hoc thuan (round 1)   2 = + defringe (round 2-3)
    # 3 = + gam mep (round 4-5)            4 = + toan bo tinh chinh (ban chot)
    [ValidateRange(1,4)] [int] $Stage = 4,

    # Chi liet ke lo kin ma khong duc, de xem so lieu truoc
    [switch] $ReportOnly,

    # Xuat them anh xem thu tren nen caro (de soi lo thung)
    [switch] $NoPreview
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$cs = @'
using System;
using System.Drawing;
using System.Drawing.Imaging;

public static class BgRemover
{
    public class Hole {
        public int Area, X0, Y0, X1, Y1;
        public double MeanDist, StdDist;
        public double ShellPx;   // vung kin nay cach NEN NGOAI gan nhat bao nhieu px
        public bool Punched;
    }

    public class Stats {
        public int BgR, BgG, BgB;
        public int TransparentPx, PartialPx, SolidPx, TotalPx;
        public int HaloPx;      // pixel ban trong suot khong bam vao vat the nao trong 3px - muc tieu 0
        public int IslandsRemoved;
        public int TrimmedPx;   // pixel gan-nen bi ket o ranh gioi, duoc gam ve nen
        public System.Collections.Generic.List<Hole> Holes = new System.Collections.Generic.List<Hole>();
    }

    public static Stats Run(string inPath, string outPath, string previewPath, int tLow, int tHigh,
                            double holeMaxMean, double holeMaxStd, int holeMinArea, double holeMaxShell,
                            double outlineRadius, int outR, int outG, int outB, int outlineSS,
                            double smoothPx, double edgeMid, int minIsland, int stage, double edgeSoft, double smoothAmt)
    {
        var st = new Stats();

        // ---- 1. Nap anh ve 32bpp ARGB ----
        int w, h;
        byte[] buf;
        using (var src = new Bitmap(inPath))
        {
            w = src.Width; h = src.Height;
            using (var canvas = new Bitmap(w, h, PixelFormat.Format32bppArgb))
            {
                using (var g = Graphics.FromImage(canvas))
                {
                    g.Clear(Color.White);
                    g.DrawImage(src, 0, 0, w, h);
                }
                buf = Lock(canvas, w, h);
            }
        }
        st.TotalPx = w * h;

        // ---- 2. Uoc luong mau nen tu vien 8px ----
        long sr = 0, sg = 0, sb = 0; long n = 0;
        int band = 8;
        for (int y = 0; y < h; y++)
        {
            bool edgeRow = (y < band || y >= h - band);
            for (int x = 0; x < w; x++)
            {
                if (!edgeRow && x >= band && x < w - band) { x = w - band - 1; continue; }
                int i = (y * w + x) * 4;
                sb += buf[i]; sg += buf[i + 1]; sr += buf[i + 2]; n++;
            }
        }
        int bgB = (int)(sb / n), bgG = (int)(sg / n), bgR = (int)(sr / n);
        st.BgR = bgR; st.BgG = bgG; st.BgB = bgB;

        // ---- 3. Khoang cach mau toi nen ----
        var dist = new byte[w * h];
        for (int p = 0; p < w * h; p++)
        {
            int i = p * 4;
            int db = Math.Abs(buf[i] - bgB);
            int dg = Math.Abs(buf[i + 1] - bgG);
            int dr = Math.Abs(buf[i + 2] - bgR);
            int d = db > dg ? db : dg; if (dr > d) d = dr;
            dist[p] = (byte)(d > 255 ? 255 : d);
        }

        // ---- 4. Flood-fill tu mep anh, chi di qua pixel CHUA chac la vat the ----
        // Day la mau chot: vung trang bi vat the bao quanh (bung ca map, long mu Noel,
        // bien ten) KHONG loang toi duoc -> giu dac. Con lo thung thong ra ngoai thi loang toi -> trong suot.
        var isBg = new bool[w * h];
        var queue = new int[w * h];
        int qh = 0, qt = 0;

        Action<int> push = p => { if (!isBg[p] && dist[p] < tHigh) { isBg[p] = true; queue[qt++] = p; } };

        for (int x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
        for (int y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }

        while (qh < qt)
        {
            int p = queue[qh++];
            int x = p % w, y = p / w;
            if (x > 0)     push(p - 1);
            if (x < w - 1) push(p + 1);
            if (y > 0)     push(p - w);
            if (y < h - 1) push(p + w);
        }

        // Do day "vo" bao quanh moi vung kin: khoang cach tu vung do toi NEN
        // NGOAI. Lo that nam trong chi tiet MANH (thanh ong, nan hoa) -> vo
        // mong. Hoa tiet trang cua ban ve (chu, nhan) nam sau trong khoi dac
        // -> vo day. Day la dau hieu tach duoc hai nhom ma mau khong tach duoc.
        var outerBg = new bool[w * h];
        Array.Copy(isBg, outerBg, w * h);
        var dOuterSq = EdtSq(outerBg, w, h);

        // ---- 4b. Lo KIN: vung sang bi vat the bao quanh, loang tu mep khong toi duoc ----
        // Khong the phan biet "lo" voi "phan trang cua vat the" bang mau, nen dung do PHANG:
        //   lo that  = mau nen nguyen chat, gan nhu khong bien thien (std thap)
        //   qua bong / ban kim / rang = co do bong, chuyen sac -> std cao hon
        var seen = new bool[w * h];
        for (int p0 = 0; p0 < w * h; p0++)
        {
            if (isBg[p0] || seen[p0] || dist[p0] >= tHigh) continue;

            int head = 0, tail = 0;
            queue[tail++] = p0; seen[p0] = true;
            var hole = new Hole { X0 = int.MaxValue, Y0 = int.MaxValue, X1 = -1, Y1 = -1 };
            double sum = 0, sumSq = 0, shellMin = double.MaxValue;
            int start = head;

            while (head < tail)
            {
                int p = queue[head++];
                int x = p % w, y = p / w;
                if (x < hole.X0) hole.X0 = x; if (x > hole.X1) hole.X1 = x;
                if (y < hole.Y0) hole.Y0 = y; if (y > hole.Y1) hole.Y1 = y;
                double d = dist[p]; sum += d; sumSq += d * d;
                double dOut = Math.Sqrt(dOuterSq[p]);
                if (dOut < shellMin) shellMin = dOut;

                if (x > 0     && !seen[p-1] && !isBg[p-1] && dist[p-1] < tHigh) { seen[p-1] = true; queue[tail++] = p-1; }
                if (x < w - 1 && !seen[p+1] && !isBg[p+1] && dist[p+1] < tHigh) { seen[p+1] = true; queue[tail++] = p+1; }
                if (y > 0     && !seen[p-w] && !isBg[p-w] && dist[p-w] < tHigh) { seen[p-w] = true; queue[tail++] = p-w; }
                if (y < h - 1 && !seen[p+w] && !isBg[p+w] && dist[p+w] < tHigh) { seen[p+w] = true; queue[tail++] = p+w; }
            }

            hole.Area = tail - start;
            hole.MeanDist = sum / hole.Area;
            hole.StdDist = Math.Sqrt(Math.Max(0, sumSq / hole.Area - hole.MeanDist * hole.MeanDist));
            hole.ShellPx = shellMin;

            if (hole.Area >= holeMinArea)
            {
                hole.Punched = (hole.MeanDist <= holeMaxMean && hole.StdDist <= holeMaxStd
                                && hole.ShellPx <= holeMaxShell);
                if (hole.Punched)
                    for (int k = start; k < tail; k++) isBg[queue[k]] = true;   // duc thung
                st.Holes.Add(hole);
            }

        }
        st.Holes.Sort((a, b) => b.Area.CompareTo(a.Area));

        // ---- 4c. Phan tich thanh phan lien thong cua vat the ----
        // Xoa: (a) dao vun ti hon GAN MAU NEN (vun nhieu JPEG) - dao co mau ro
        // rang (soi long, cham ve) la chi tiet that nen giu; (b) manh CHAM MEP
        // ANH nho hon 25% thanh phan lon nhat - do la rac cat anh cua nguon
        // (thiet ke that co le/margin, con thiet ke tran le se la manh lon nhat).
        {
            var comp = new int[w * h];
            var compArea = new System.Collections.Generic.List<long>();
            var compDist = new System.Collections.Generic.List<long>();
            var compBorder = new System.Collections.Generic.List<bool>();
            for (int p = 0; p < w * h; p++) comp[p] = -1;

            for (int p0 = 0; p0 < w * h; p0++)
            {
                if (isBg[p0] || comp[p0] >= 0) continue;
                int id = compArea.Count;
                int head = 0, tail = 0;
                long distSum = 0; bool border = false;
                queue[tail++] = p0; comp[p0] = id;
                while (head < tail)
                {
                    int p = queue[head++];
                    distSum += dist[p];
                    int x = p % w, y = p / w;
                    if (x == 0 || y == 0 || x == w - 1 || y == h - 1) border = true;
                    if (x > 0     && comp[p-1] < 0 && !isBg[p-1]) { comp[p-1] = id; queue[tail++] = p-1; }
                    if (x < w - 1 && comp[p+1] < 0 && !isBg[p+1]) { comp[p+1] = id; queue[tail++] = p+1; }
                    if (y > 0     && comp[p-w] < 0 && !isBg[p-w]) { comp[p-w] = id; queue[tail++] = p-w; }
                    if (y < h - 1 && comp[p+w] < 0 && !isBg[p+w]) { comp[p+w] = id; queue[tail++] = p+w; }
                }
                compArea.Add(tail); compDist.Add(distSum); compBorder.Add(border);
            }

            long maxArea = 1;
            for (int i2 = 0; i2 < compArea.Count; i2++) if (compArea[i2] > maxArea) maxArea = compArea[i2];

            var kill = new bool[compArea.Count];
            for (int i2 = 0; i2 < compArea.Count; i2++)
            {
                bool speck = minIsland > 0 && compArea[i2] < minIsland
                             && (double)compDist[i2] / compArea[i2] < 22.0;
                bool scrap = stage >= 4 && compBorder[i2] && compArea[i2] * 4 < maxArea;
                if (speck || scrap) { kill[i2] = true; st.IslandsRemoved++; }
            }
            for (int p = 0; p < w * h; p++)
                if (comp[p] >= 0 && kill[comp[p]]) isBg[p] = true;
        }

        // ---- 4d. Gam mep (frontier BFS): got pixel gan-nen bi ket o ranh gioi ----
        // Ba loai tan du ma flood-fill khong toi duoc: nem trang ket goc lom,
        // hanh lang sang giua hai chi tiet manh, lop vo trang ngoai cung cua
        // bien vat the toi. Hai luat:
        //   Luat thuong : dist<48, est<0.42, DO SAU <= 5px  (chan duc xuyen vat
        //                 the trang men theo ranh bong toi - loi thap Philly)
        //   Luat kep    : pixel co NEN GOC o CA HAI phia trong +/-4px theo mot
        //                 truc (hanh lang giua 2 soi chi) -> noi dist<60,
        //                 est<0.62, khong gioi han sau. Kiem tren SNAPSHOT nen
        //                 truoc khi gam de khong tu khuech dai.
        if (stage >= 3) {
            int nPix = w * h;
            var origBg = new bool[nPix];
            Array.Copy(isBg, origBg, nPix);
            var depth = new byte[nPix];
            var inQ = new bool[nPix];
            long qh2 = 0, qt2 = 0;
            for (int y = 0; y < h; y++)
                for (int x = 0; x < w; x++)
                {
                    int p = y * w + x;
                    if (isBg[p]) continue;
                    if ((x > 0 && isBg[p-1]) || (x < w-1 && isBg[p+1]) ||
                        (y > 0 && isBg[p-w]) || (y < h-1 && isBg[p+w]))
                    { queue[qt2 % nPix] = p; qt2++; inQ[p] = true; depth[p] = 1; }
                }
            while (qh2 < qt2)
            {
                int p = queue[qh2 % nPix]; qh2++; inQ[p] = false;
                if (isBg[p]) continue;
                int d = dist[p];
                if (d >= 60) continue;
                int px = p % w, py = p / w;

                int fd = 1;                                    // tuong phan cuc bo 5x5
                // 5x5 chu khong phai 7x7: cua so rong hon se voi toi vanh sam
                // cua num bi bac va an nham highlight sang tren dinh (loi bat
                // duoc o montage 4-stage; vung nay khong duoc giam dinh lai
                // sau round 4 nen lot luoi)
                for (int yy = Math.Max(0, py-2); yy <= Math.Min(h-1, py+2); yy++)
                {
                    int row = yy * w;
                    for (int xx = Math.Max(0, px-2); xx <= Math.Min(w-1, px+2); xx++)
                        if (dist[row+xx] > fd) fd = dist[row+xx];
                }

                bool ok = (d < 48 && d * 100 < fd * 42 && depth[p] <= 5);
                if (!ok && stage >= 4 && d * 100 < fd * 62)
                {
                    // luat kep: nen GOC o ca hai phia, va duong toi nen phai
                    // XUYEN QUA mot pixel dam (d>=60) - tuc pixel nay nam giua
                    // hai net ve sam (hanh lang giua 2 soi chi). Tua long mo
                    // bi nen kep TRUC TIEP (khong co net dam chan giua) -> giu.
                    // quet toi 4px; neu da gap net dam thi noi toi 7px (net ve
                    // + vien nhoe cua no day hon 4px)
                    bool L = false, R = false, U = false, D2 = false;
                    bool dk;
                    dk = false; for (int k = 1; k <= 7; k++) { if (px - k < 0 || (k > 4 && !dk)) break; int pp = p - k;
                        if (origBg[pp]) { if (dk) L = true; break; } if (dist[pp] >= 60) dk = true; }
                    dk = false; for (int k = 1; k <= 7; k++) { if (px + k >= w || (k > 4 && !dk)) break; int pp = p + k;
                        if (origBg[pp]) { if (dk) R = true; break; } if (dist[pp] >= 60) dk = true; }
                    dk = false; for (int k = 1; k <= 7; k++) { if (py - k < 0 || (k > 4 && !dk)) break; int pp = p - k * w;
                        if (origBg[pp]) { if (dk) U = true; break; } if (dist[pp] >= 60) dk = true; }
                    dk = false; for (int k = 1; k <= 7; k++) { if (py + k >= h || (k > 4 && !dk)) break; int pp = p + k * w;
                        if (origBg[pp]) { if (dk) D2 = true; break; } if (dist[pp] >= 60) dk = true; }
                    ok = (L && R) || (U && D2);
                }
                if (!ok) continue;

                isBg[p] = true;
                st.TrimmedPx++;
                byte nd = (byte)Math.Min(255, depth[p] + 1);
                if (px > 0     && !isBg[p-1] && !inQ[p-1]) { queue[qt2 % nPix] = p-1; qt2++; inQ[p-1] = true; depth[p-1] = nd; }
                if (px < w - 1 && !isBg[p+1] && !inQ[p+1]) { queue[qt2 % nPix] = p+1; qt2++; inQ[p+1] = true; depth[p+1] = nd; }
                if (py > 0     && !isBg[p-w] && !inQ[p-w]) { queue[qt2 % nPix] = p-w; qt2++; inQ[p-w] = true; depth[p-w] = nd; }
                if (py < h - 1 && !isBg[p+w] && !inQ[p+w]) { queue[qt2 % nPix] = p+w; qt2++; inQ[p+w] = true; depth[p+w] = nd; }
            }
        }

        // ---- 4d2. Va LO KIM: cum nen KIN ti hon do buoc gam mep vo tinh tao
        // ra khi hai mep gam giap nhau o goc noi. Lo THAT (kieu chu C) deu
        // >= holeMinArea (400px) nen khong the bi dung toi.
        {
            var seenH = new bool[w * h];
            for (int p0 = 0; p0 < w * h; p0++)
            {
                if (!isBg[p0] || seenH[p0]) continue;
                int head = 0, tail = 0; bool touchBorder = false;
                queue[tail++] = p0; seenH[p0] = true;
                while (head < tail)
                {
                    int p = queue[head++];
                    int x = p % w, y = p / w;
                    if (x == 0 || y == 0 || x == w - 1 || y == h - 1) touchBorder = true;
                    if (x > 0     && !seenH[p-1] && isBg[p-1]) { seenH[p-1] = true; queue[tail++] = p-1; }
                    if (x < w - 1 && !seenH[p+1] && isBg[p+1]) { seenH[p+1] = true; queue[tail++] = p+1; }
                    if (y > 0     && !seenH[p-w] && isBg[p-w]) { seenH[p-w] = true; queue[tail++] = p-w; }
                    if (y < h - 1 && !seenH[p+w] && isBg[p+w]) { seenH[p+w] = true; queue[tail++] = p+w; }
                }
                if (!touchBorder && tail < 40)
                    for (int k = 0; k < tail; k++) isBg[queue[k]] = false;
            }
        }

        // ---- 4e. Cum sang ti hon bam canh vat the RAT TOI ----
        // Dom trang <=12px mau gan nen (dist<40), cham nen, nam sat canh vat
        // the toi (fd>=120): tan du JPEG o hom lom (vong ring bao ve loi khien
        // flood va gam mep deu khong toi duoc). Tua long tach roi an toan vi
        // quanh no khong co gi toi (fd<120); hat ngoc an toan vi to (>12px).
        if (stage >= 4) {
            var seenB = new bool[w * h];
            for (int p0 = 0; p0 < w * h; p0++)
            {
                if (isBg[p0] || seenB[p0] || dist[p0] >= 26) continue;
                int head = 0, tail = 0;
                queue[tail++] = p0; seenB[p0] = true;
                bool touchBg = false; int fdLoc = 0;
                while (head < tail && tail <= 13)
                {
                    int p = queue[head++];
                    int x = p % w, y = p / w;
                    for (int yy = Math.Max(0, y-2); yy <= Math.Min(h-1, y+2); yy++)
                    {
                        int row = yy * w;
                        for (int xx = Math.Max(0, x-2); xx <= Math.Min(w-1, x+2); xx++)
                        {
                            if (isBg[row+xx]) touchBg = true;
                            if (dist[row+xx] > fdLoc) fdLoc = dist[row+xx];
                        }
                    }
                    if (x > 0     && !seenB[p-1] && !isBg[p-1] && dist[p-1] < 26) { seenB[p-1] = true; queue[tail++] = p-1; }
                    if (x < w - 1 && !seenB[p+1] && !isBg[p+1] && dist[p+1] < 26) { seenB[p+1] = true; queue[tail++] = p+1; }
                    if (y > 0     && !seenB[p-w] && !isBg[p-w] && dist[p-w] < 26) { seenB[p-w] = true; queue[tail++] = p-w; }
                    if (y < h - 1 && !seenB[p+w] && !isBg[p+w] && dist[p+w] < 26) { seenB[p+w] = true; queue[tail++] = p+w; }
                }
                if (tail <= 8 && touchBg && fdLoc >= 120)
                {
                    for (int k = 0; k < tail; k++) { isBg[queue[k]] = true; st.TrimmedPx++; }
                }
            }
        }

        // ---- 5. ALPHA HINH HOC ----
        // Alpha suy tu MAU tung pixel se bi nhieu JPEG chi phoi -> quang mo quanh
        // chi tiet sang, bien nham nho, moi lan chinh nguong chi don loi di cho
        // khac. Thay han bang: lay mask NHI PHAN (sau flood + duc lo), lam muot
        // duong bien bang hinh hoc roi lay mau sieu phan giai. Alpha chi con phu
        // thuoc VI TRI bien -> deu ~1px tren toan anh, khong the sinh quang.
        var alpha = GeomAlpha(isBg, w, h, 4, smoothPx, edgeMid, edgeSoft, smoothAmt);

        // Chong HAN LAI: blur lam muot co the lap hom lom nho -> pixel da quyet
        // la nen bong dung alpha cao tro lai. Ep ve 0 (nguong 150 de khong dung
        // vao khu rang cua binh thuong o goc lom, von chi len toi ~130).
        if (stage >= 4)
            for (int y = 0; y < h; y++)
                for (int x = 0; x < w; x++)
                {
                    int p = y * w + x;
                    if (!isBg[p] || alpha[p] < 150) continue;
                    // Chi ep ve 0 khi pixel nam THAT SU trong vung nen. Mot pixel
                    // nen le loi lot giua vat the (buoc gam mep hay tao ra o goc
                    // noi) neu bi ep se thanh LO KIM den giua dai alpha muot.
                    int nb = 0;
                    for (int dy = -1; dy <= 1; dy++)
                        for (int dx = -1; dx <= 1; dx++)
                        {
                            if (dx == 0 && dy == 0) continue;
                            int yy = y + dy, xx = x + dx;
                            if (yy < 0 || yy >= h || xx < 0 || xx >= w) { nb++; continue; }
                            if (isBg[yy * w + xx]) nb++;
                        }
                    if (nb >= 5) alpha[p] = 0;
                }

        // Ban kinh "mo neo" phai RONG HON dai chuyen tiep, khong thi buoc don
        // vun se xen cut phan ngoai cua dai va chan tran EdgeSoft (~5.2px).
        int spekR = Math.Max(3, (int)Math.Ceiling(edgeSoft) + 2);

        // Don vun mo: mang ban trong suot khong bam vao pixel dac (255) nao
        // trong ban kinh 3px la tan du cua chi tiet mong hon 1px da bong ra
        // khi lam muot -> xoa han (alpha dac khong doi nen 1 luot la du).
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++)
            {
                int p = y * w + x;
                if (alpha[p] == 0 || alpha[p] == 255) continue;
                bool anchored = false;
                for (int yy = Math.Max(0, y - spekR); yy <= Math.Min(h - 1, y + spekR) && !anchored; yy++)
                    for (int xx = Math.Max(0, x - spekR); xx <= Math.Min(w - 1, x + spekR); xx++)
                        if (alpha[yy * w + xx] == 255) { anchored = true; break; }
                if (!anchored) alpha[p] = 0;
            }

        // ---- 5b. Defringe: keo mau nen ra khoi DAI BIEN (ke ca pixel dac) ----
        // Pixel sat bien co the alpha=255 nhung mau van con 60-90% trang nen
        // (duoi JPEG lam nhoe bien) -> thanh duong trang bam mep khi in len nen
        // toi. He so unmix dung ty le pha mau THAT: est = dist / tuong phan cuc
        // bo, chu khong dung alpha hinh hoc (alpha do do phu, khong do pha mau).
        if (stage >= 2) {
            // dai bien = pixel vat the trong vong 2px quanh pixel trong suot
            var edgeBand = new bool[w * h];
            for (int y = 0; y < h; y++)
                for (int x = 0; x < w; x++)
                {
                    int p = y * w + x;
                    if (alpha[p] == 0) continue;
                    bool nearClear = false;
                    for (int yy = Math.Max(0, y - 2); yy <= Math.Min(h - 1, y + 2) && !nearClear; yy++)
                        for (int xx = Math.Max(0, x - 2); xx <= Math.Min(w - 1, x + 2); xx++)
                            if (alpha[yy * w + xx] == 0) { nearClear = true; break; }
                    edgeBand[p] = nearClear;
                }

            const int WIN = 4;
            for (int y = 0; y < h; y++)
                for (int x = 0; x < w; x++)
                {
                    int p = y * w + x;
                    if (!edgeBand[p]) continue;
                    // fd = tuong phan cua MO NEO GAN MAU NHAT (solid nho nhat ma
                    // van >= dSm), khong phai manh nhat. Tai giao diem long trang
                    // - mu do, dung max se muon tuong phan cua mu de sua mau
                    // long -> qua tay thanh xam dam.
                    int fdMax = 1, fdNear = int.MaxValue;
                    for (int yy = Math.Max(0, y - WIN); yy <= Math.Min(h - 1, y + WIN); yy++)
                    {
                        int row = yy * w;
                        for (int xx = Math.Max(0, x - WIN); xx <= Math.Min(w - 1, x + WIN); xx++)
                            if (alpha[row + xx] == 255)
                            {
                                int dv = dist[row + xx];
                                if (dv > fdMax) fdMax = dv;
                            }
                    }
                    // dist lam muot 3x3 -> est bien thien tron tru doc theo bien,
                    // het hien tuong day gach do/trang lom dom do nhieu tung pixel
                    int dSum = 0, dCnt = 0;
                    for (int yy = Math.Max(0, y - 1); yy <= Math.Min(h - 1, y + 1); yy++)
                    {
                        int row = yy * w;
                        for (int xx = Math.Max(0, x - 1); xx <= Math.Min(w - 1, x + 1); xx++)
                            if (alpha[row + xx] > 0) { dSum += dist[row + xx]; dCnt++; }
                    }
                    double dSm = dCnt > 0 ? (double)dSum / dCnt : dist[p];
                    for (int yy = Math.Max(0, y - WIN); yy <= Math.Min(h - 1, y + WIN); yy++)
                    {
                        int row = yy * w;
                        for (int xx = Math.Max(0, x - WIN); xx <= Math.Min(w - 1, x + WIN); xx++)
                            if (alpha[row + xx] == 255)
                            {
                                int dv = dist[row + xx];
                                if (dv >= dSm * 0.95 && dv < fdNear) fdNear = dv;
                            }
                    }
                    int fd = (stage >= 4 && fdNear != int.MaxValue) ? fdNear : fdMax;
                    double est = dSm / fd;
                    // Chan duoi VAT LY: neu P = est*F + (1-est)*nen thi bat buoc
                    // est >= 1 - P/nen (F khong the am). est thap hon nghia la
                    // uoc luong sai -> nang len, +0.08 du phong de khong che ra
                    // mau den tuyen doi.
                    {
                        int i0 = p * 4;
                        double lb = 0;
                        if (bgB > 0) { double v = 1.0 - (double)buf[i0]     / bgB; if (v > lb) lb = v; }
                        if (bgG > 0) { double v = 1.0 - (double)buf[i0 + 1] / bgG; if (v > lb) lb = v; }
                        if (bgR > 0) { double v = 1.0 - (double)buf[i0 + 2] / bgR; if (v > lb) lb = v; }
                        lb += 0.08; if (lb > 0.95) lb = 0.95;
                        if (stage >= 4 && est < lb) est = lb;
                    }
                    // Chan duoi HINH HOC: ty le pha mau khong the thap hon nhieu
                    // so voi DO PHU (alpha). Neu thap hon, phep chia khuech dai
                    // qua muc va day pixel ve den - dung la cac cham den lom
                    // chom bam tren duong bien. Cho phep lech toi 25% de van sua
                    // duoc phan nen bi JPEG lam nhoe lan vao pixel dac.
                    if (stage >= 4)
                    {
                        double aFloor = (alpha[p] / 255.0) * 0.75;
                        if (est < aFloor) est = aFloor;
                    }
                    if (est >= 0.97) continue;              // da la mau vat the thuan
                    if (est < 0.34) est = 0.34;             // chan khuech dai -> khong che vet mau qua bao hoa
                    int i = p * 4;
                    buf[i]     = UnmixD(buf[i],     bgB, est);
                    buf[i + 1] = UnmixD(buf[i + 1], bgG, est);
                    buf[i + 2] = UnmixD(buf[i + 2], bgR, est);
                }
        }

        for (int p = 0; p < w * h; p++)
        {
            int i = p * 4;
            int a = alpha[p];
            if (a == 0) { buf[i] = 0; buf[i+1] = 0; buf[i+2] = 0; buf[i+3] = 0; st.TransparentPx++; }
            else
            {
                if (a < 255)
                {
                    st.PartialPx++;
                    if (stage < 2)
                    {
                        buf[i]     = Unmix(buf[i],     bgB, a);
                        buf[i + 1] = Unmix(buf[i + 1], bgG, a);
                        buf[i + 2] = Unmix(buf[i + 2], bgR, a);
                    }
                }
                else st.SolidPx++;
                buf[i + 3] = (byte)a;
            }
        }

        // Thuoc do QUANG: pixel ban trong suot khong cham vat the dac trong 3px.
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++)
            {
                int a = buf[(y * w + x) * 4 + 3];
                if (a == 0 || a == 255) continue;
                bool anchored = false;
                for (int yy = Math.Max(0, y - spekR); yy <= Math.Min(h - 1, y + spekR) && !anchored; yy++)
                    for (int xx = Math.Max(0, x - spekR); xx <= Math.Min(w - 1, x + spekR); xx++)
                        if (buf[(yy * w + xx) * 4 + 3] == 255) { anchored = true; break; }
                if (!anchored) st.HaloPx++;
            }

        // ---- 6. Vien trang bao quanh (kieu die-cut sticker) ----
        if (outlineRadius >= 0.5) AddOutline(buf, w, h, outlineRadius, outR, outG, outB, outlineSS);

        Save(buf, w, h, outPath);
        if (!string.IsNullOrEmpty(previewPath)) SavePreview(buf, w, h, previewPath);
        return st;
    }

    const float INF = 1e20f;

    // Nong mask ra ban kinh R roi to mau -> vien bo tron deu, ke ca o goc nhon.
    //
    // Toan bo phep tinh chay o do phan giai gap `ss` lan roi moi ha xuong. Ly do:
    // neu lay mau nhi phan ngay o do phan giai goc thi vi tri bien bi lam tron ve
    // tam pixel, va duong dong muc cua truong khoang cach se gay khuc thanh bac
    // thang. Phong to truoc -> bien chinh xac toi 1/ss pixel; ha xuong bang trung
    // binh o ss*ss -> khu rang cua that su, khong phai bôi mo che loi.
    static void AddOutline(byte[] buf, int w, int h, double radius, int oR, int oG, int oB, int ss)
    {
        if (ss < 1) ss = 1;
        int W = w * ss, H = h * ss;
        var d = new float[(long)W * H];

        // Alpha hieu dung: lo kin NHO HON dao cat (canh bbox be hon 4*ban kinh)
        // duoc lap day - vien tu hai phia von se lap gan het va de lai ria nham
        // nho, nen lap han cho sach (dung chuan die-cut: lo duoi kich thuoc dao
        // thi khong cat). Vung lap se duoc to mau vien o buoc ghep.
        var alphaEff = new byte[w * h];
        for (int p = 0; p < w * h; p++) alphaEff[p] = buf[p * 4 + 3];
        {
            int minKeep = (int)Math.Ceiling(radius * 4.0);
            var visited = new bool[w * h];
            var q = new int[w * h];
            int qh = 0, qt = 0;
            for (int x = 0; x < w; x++)
                foreach (int pp in new[] { x, (h - 1) * w + x })
                    if (!visited[pp] && alphaEff[pp] < 128) { visited[pp] = true; q[qt++] = pp; }
            for (int y = 0; y < h; y++)
                foreach (int pp in new[] { y * w, y * w + w - 1 })
                    if (!visited[pp] && alphaEff[pp] < 128) { visited[pp] = true; q[qt++] = pp; }
            while (qh < qt)
            {
                int p = q[qh++];
                int x = p % w, y = p / w;
                if (x > 0     && !visited[p-1] && alphaEff[p-1] < 128) { visited[p-1] = true; q[qt++] = p-1; }
                if (x < w - 1 && !visited[p+1] && alphaEff[p+1] < 128) { visited[p+1] = true; q[qt++] = p+1; }
                if (y > 0     && !visited[p-w] && alphaEff[p-w] < 128) { visited[p-w] = true; q[qt++] = p-w; }
                if (y < h - 1 && !visited[p+w] && alphaEff[p+w] < 128) { visited[p+w] = true; q[qt++] = p+w; }
            }
            for (int p0 = 0; p0 < w * h; p0++)
            {
                if (visited[p0] || alphaEff[p0] >= 128) continue;
                int hh = 0, tt = 0;
                q[tt++] = p0; visited[p0] = true;
                int x0 = int.MaxValue, y0 = int.MaxValue, x1 = -1, y1 = -1;
                while (hh < tt)
                {
                    int p = q[hh++];
                    int x = p % w, y = p / w;
                    if (x < x0) x0 = x; if (x > x1) x1 = x;
                    if (y < y0) y0 = y; if (y > y1) y1 = y;
                    if (x > 0     && !visited[p-1] && alphaEff[p-1] < 128) { visited[p-1] = true; q[tt++] = p-1; }
                    if (x < w - 1 && !visited[p+1] && alphaEff[p+1] < 128) { visited[p+1] = true; q[tt++] = p+1; }
                    if (y > 0     && !visited[p-w] && alphaEff[p-w] < 128) { visited[p-w] = true; q[tt++] = p-w; }
                    if (y < h - 1 && !visited[p+w] && alphaEff[p+w] < 128) { visited[p+w] = true; q[tt++] = p+w; }
                }
                if (Math.Min(x1 - x0 + 1, y1 - y0 + 1) <= minKeep)
                    for (int k = 0; k < tt; k++) alphaEff[q[k]] = 255;
            }
        }

        // Noi suy song tuyen tinh tu alpha goc -> giu duoc vi tri bien duoi-pixel
        for (int Y = 0; Y < H; Y++)
        {
            double sy = (Y + 0.5) / ss - 0.5;
            int y0 = (int)Math.Floor(sy); double fy = sy - y0;
            int y1 = y0 + 1;
            if (y0 < 0) y0 = 0; if (y0 > h - 1) y0 = h - 1;
            if (y1 < 0) y1 = 0; if (y1 > h - 1) y1 = h - 1;

            int rowOut = Y * W;
            for (int X = 0; X < W; X++)
            {
                double sx = (X + 0.5) / ss - 0.5;
                int x0 = (int)Math.Floor(sx); double fx = sx - x0;
                int x1 = x0 + 1;
                if (x0 < 0) x0 = 0; if (x0 > w - 1) x0 = w - 1;
                if (x1 < 0) x1 = 0; if (x1 > w - 1) x1 = w - 1;

                double a00 = alphaEff[y0 * w + x0], a10 = alphaEff[y0 * w + x1];
                double a01 = alphaEff[y1 * w + x0], a11 = alphaEff[y1 * w + x1];
                double a = (a00 * (1 - fx) + a10 * fx) * (1 - fy) + (a01 * (1 - fx) + a11 * fx) * fy;
                d[rowOut + X] = (a >= 127.5) ? 0f : INF;
            }
        }

        int m = Math.Max(W, H);
        var f = new float[m]; var dd = new float[m]; var v = new int[m]; var z = new float[m + 1];

        for (int x = 0; x < W; x++)                       // pass theo cot
        {
            for (int y = 0; y < H; y++) f[y] = d[(long)y * W + x];
            Dt1d(f, dd, v, z, H);
            for (int y = 0; y < H; y++) d[(long)y * W + x] = dd[y];
        }
        for (int y = 0; y < H; y++)                       // pass theo hang
        {
            long row = (long)y * W;
            for (int x = 0; x < W; x++) f[x] = d[row + x];
            Dt1d(f, dd, v, z, W);
            for (int x = 0; x < W; x++) d[row + x] = dd[x];
        }

        // Ha xuong do phan giai goc: trung binh do phu tren o ss*ss
        double R = radius * ss;
        var oaFull = new float[w * h];
        for (int Y = 0; Y < H; Y++)
        {
            long row = (long)Y * W;
            int oy = Y / ss;
            for (int X = 0; X < W; X++)
            {
                double oa = R + 0.5 - Math.Sqrt(d[row + X]);
                if (oa <= 0) continue;
                if (oa > 1) oa = 1;
                oaFull[oy * w + X / ss] += (float)oa;
            }
        }
        d = null;
        double inv = 1.0 / (ss * ss);

        for (int p = 0; p < w * h; p++)
        {
            double oa = oaFull[p] * inv;
            if (oa <= 0) continue;
            if (oa > 1) oa = 1;

            double fa = buf[p * 4 + 3] / 255.0;            // alpha vat the goc
            double na = fa + oa * (1 - fa);                // ghep: vat the DE LEN lop vien
            if (na <= 0) continue;

            int i = p * 4;
            buf[i]     = MixOver(buf[i],     fa, oB, oa, na);
            buf[i + 1] = MixOver(buf[i + 1], fa, oG, oa, na);
            buf[i + 2] = MixOver(buf[i + 2], fa, oR, oa, na);
            buf[i + 3] = (byte)Math.Round(na * 255);
        }
    }

    static byte MixOver(byte fg, double fa, int bg, double oa, double na)
    {
        double v = (fg * fa + bg * oa * (1 - fa)) / na;
        return (byte)(v < 0 ? 0 : (v > 255 ? 255 : Math.Round(v)));
    }

    // Bien doi khoang cach binh phuong 1 chieu - Felzenszwalb & Huttenlocher
    static void Dt1d(float[] f, float[] d, int[] v, float[] z, int n)
    {
        int k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
        for (int q = 1; q < n; q++)
        {
            float s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
            while (s <= z[k])
            {
                k--;
                s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
            }
            k++; v[k] = q; z[k] = s; z[k + 1] = INF;
        }
        k = 0;
        for (int q = 0; q < n; q++)
        {
            while (z[k + 1] < q) k++;
            d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
        }
    }

    // Mask nhi phan -> alpha khu rang cua, qua TRUONG KHOANG CACH CO DAU (SDF).
    //
    // Cach cu (lam nhoe mask 0/1 roi ep nguong) co hai tat:
    //   - Truong sau khi nhoe la phi tuyen, be rong doc alpha phu thuoc sigma,
    //     thuc te chi ~0.85px - HEP HON bien do dao dong vi tri contour (+/-0.5px)
    //     nen moi gon song deu hien thanh bac thang.
    //   - Lam nhoe mask co thien kien CO LAI, chi tiet manh bi teo.
    // SDF khong bi ca hai: truong tuyen tinh quanh bien nen be rong doc dat duoc
    // CHINH XAC theo pixel (edgeSoft), va lam muot SDF khong lam teo net manh.
    static byte[] GeomAlpha(bool[] isBg, int w, int h, int ss,
                            double smoothPx, double edgeMid, double edgeSoft, double smoothAmt)
    {
        int n = w * h;
        var isObj = new bool[n];
        for (int p = 0; p < n; p++) isObj[p] = !isBg[p];

        var dToBg  = EdtSq(isBg,  w, h);   // khoang cach toi pixel NEN gan nhat
        var dToObj = EdtSq(isObj, w, h);   // khoang cach toi pixel VAT THE gan nhat

        // SDF: duong + o trong vat the, - o ngoai; goc toa do dat giua hai lop
        // pixel (tru 0.5) nen bien nam dung giua, khong lech nua pixel.
        var S = new float[n];
        for (int p = 0; p < n; p++)
            S[p] = isBg[p] ? -(float)(Math.Sqrt(dToObj[p]) - 0.5)
                           :  (float)(Math.Sqrt(dToBg[p])  - 0.5);
        dToBg = null; dToObj = null;

        int r = (int)Math.Round(smoothPx);
        if (r >= 1) BoxBlur3(S, w, h, r);   // lam muot HINH DANG (got gon song)

        double half = Math.Max(0.3, edgeSoft) * 0.5;   // nua be rong doc, don vi px
        double bias = (edgeMid - 0.5) * 6.0;           // >0.5 keo bien vao trong
        var outA = new byte[n];
        double step = 1.0 / ss;

        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++)
            {
                // loi tat: ca vung 3x3 nam han mot phia cua doc -> khoi lay mau
                float lo = float.MaxValue, hi = float.MinValue;
                for (int yy = Math.Max(0, y - 1); yy <= Math.Min(h - 1, y + 1); yy++)
                    for (int xx = Math.Max(0, x - 1); xx <= Math.Min(w - 1, x + 1); xx++)
                    {
                        float v = S[yy * w + xx];
                        if (v < lo) lo = v; if (v > hi) hi = v;
                    }
                if (lo - bias >=  half) { outA[y * w + x] = 255; continue; }
                if (hi - bias <= -half) { outA[y * w + x] = 0;   continue; }

                float sum = 0;
                for (int sy = 0; sy < ss; sy++)
                {
                    double fy = y + (sy + 0.5) * step - 0.5;
                    int y0 = (int)Math.Floor(fy); double wy = fy - y0;
                    int y1 = y0 + 1;
                    if (y0 < 0) y0 = 0; if (y0 > h - 1) y0 = h - 1;
                    if (y1 < 0) y1 = 0; if (y1 > h - 1) y1 = h - 1;
                    for (int sx = 0; sx < ss; sx++)
                    {
                        double fx = x + (sx + 0.5) * step - 0.5;
                        int x0 = (int)Math.Floor(fx); double wx = fx - x0;
                        int x1 = x0 + 1;
                        if (x0 < 0) x0 = 0; if (x0 > w - 1) x0 = w - 1;
                        if (x1 < 0) x1 = 0; if (x1 > w - 1) x1 = w - 1;
                        double v = (S[y0 * w + x0] * (1 - wx) + S[y0 * w + x1] * wx) * (1 - wy)
                                 + (S[y1 * w + x0] * (1 - wx) + S[y1 * w + x1] * wx) * wy;
                        double t = 0.5 + (v - bias) / (half * 2.0);
                        if (t < 0) t = 0; else if (t > 1) t = 1;
                        double tS = t * t * (3.0 - 2.0 * t);
                        t = t + (tS - t) * smoothAmt;  // smoothstep: vai mem hai
                        // dau, doc o giua - giong bien mem tu nhien cua ban ve,
                        // thay vi doc thang co goc gay o hai dau dai.
                        sum += (float)t;
                    }
                }
                int a = (int)Math.Round(sum * 255.0 / (ss * ss));
                outA[y * w + x] = (byte)(a < 0 ? 0 : (a > 255 ? 255 : a));
            }
        return outA;
    }

    // Bien doi khoang cach Euclid BINH PHUONG chinh xac (Felzenszwalb), hat giong
    // la cac pixel seed=true.
    static float[] EdtSq(bool[] seed, int w, int h)
    {
        int n = w * h;
        var d = new float[n];
        for (int p = 0; p < n; p++) d[p] = seed[p] ? 0f : INF;
        int m = Math.Max(w, h);
        var f = new float[m]; var dd = new float[m]; var v = new int[m]; var z = new float[m + 1];
        for (int x = 0; x < w; x++)
        {
            for (int y = 0; y < h; y++) f[y] = d[y * w + x];
            Dt1d(f, dd, v, z, h);
            for (int y = 0; y < h; y++) d[y * w + x] = dd[y];
        }
        for (int y = 0; y < h; y++)
        {
            int row = y * w;
            for (int x = 0; x < w; x++) f[x] = d[row + x];
            Dt1d(f, dd, v, z, w);
            for (int x = 0; x < w; x++) d[row + x] = dd[x];
        }
        return d;
    }
    // Box blur tach truc, 3 luot (~Gaussian sigma ~1.4*r). Truot cong don theo
    // hang o ca hai truc de truy cap bo nho tuan tu.
    static void BoxBlur3(float[] F, int w, int h, int r)
    {
        int n = w * h;
        var scratch = new float[n];
        var rowT = new float[w];
        var colSum = new float[w];
        float inv = 1f / (2 * r + 1);

        for (int pass = 0; pass < 3; pass++)
        {
            // ngang
            for (int y = 0; y < h; y++)
            {
                int row = y * w;
                float s = 0;
                for (int k = -r; k <= r; k++) s += F[row + ClampI(k, w)];
                for (int x = 0; x < w; x++)
                {
                    rowT[x] = s * inv;
                    s += F[row + ClampI(x + r + 1, w)] - F[row + ClampI(x - r, w)];
                }
                Array.Copy(rowT, 0, F, row, w);
            }
            // doc
            for (int x = 0; x < w; x++) colSum[x] = F[x] * (r + 1);
            for (int y = 1; y <= r; y++)
            {
                int row = ClampI(y, h) * w;
                for (int x = 0; x < w; x++) colSum[x] += F[row + x];
            }
            for (int y = 0; y < h; y++)
            {
                int rowOut = y * w;
                for (int x = 0; x < w; x++) scratch[rowOut + x] = colSum[x] * inv;
                int rAdd = ClampI(y + r + 1, h) * w, rSub = ClampI(y - r, h) * w;
                for (int x = 0; x < w; x++) colSum[x] += F[rAdd + x] - F[rSub + x];
            }
            Array.Copy(scratch, F, n);
        }
    }

    static int ClampI(int v, int nMax) { return v < 0 ? 0 : (v >= nMax ? nMax - 1 : v); }

    static byte Unmix(byte px, int bg, int a)
    {
        int v = ((px - bg) * 255 + bg * a) / a;
        return (byte)(v < 0 ? 0 : (v > 255 ? 255 : v));
    }

    // Unmix voi he so pha mau thuc (est trong [0..1]): F = (P - (1-est)*bg) / est
    static byte UnmixD(byte px, int bg, double est)
    {
        double v = (px - (1.0 - est) * bg) / est;
        return (byte)(v < 0 ? 0 : (v > 255 ? 255 : Math.Round(v)));
    }

    static byte[] Lock(Bitmap bmp, int w, int h)
    {
        var data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        var buf = new byte[w * h * 4];
        System.Runtime.InteropServices.Marshal.Copy(data.Scan0, buf, 0, buf.Length);
        bmp.UnlockBits(data);
        return buf;
    }

    static void Save(byte[] buf, int w, int h, string path)
    {
        using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
        {
            var data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
            System.Runtime.InteropServices.Marshal.Copy(buf, 0, data.Scan0, buf.Length);
            bmp.UnlockBits(data);
            bmp.Save(path, ImageFormat.Png);
        }
    }

    // Ghep len nen caro de nhin thay lo thung / vung trong suot
    static void SavePreview(byte[] buf, int w, int h, string path)
    {
        var outBuf = new byte[w * h * 4];
        int cell = Math.Max(16, w / 64);
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++)
            {
                int i = (y * w + x) * 4;
                int chk = (((x / cell) + (y / cell)) % 2 == 0) ? 0xA8 : 0xD8;
                int a = buf[i + 3];
                outBuf[i]     = (byte)((buf[i]     * a + chk * (255 - a)) / 255);
                outBuf[i + 1] = (byte)((buf[i + 1] * a + chk * (255 - a)) / 255);
                outBuf[i + 2] = (byte)((buf[i + 2] * a + chk * (255 - a)) / 255);
                outBuf[i + 3] = 255;
            }
        Save(outBuf, w, h, path);
    }
}
'@

Add-Type -TypeDefinition $cs -ReferencedAssemblies System.Drawing -ErrorAction Stop

# ---------- thu thap file dau vao ----------
$item = Get-Item -LiteralPath $Path
if ($item.PSIsContainer) {
    # Bo qua anh CHUAN doi chieu (vd test-Photoroom.png) - do la ket qua cua
    # tool khac, khong phai anh nguon can tach nen.
    $files = Get-ChildItem -LiteralPath $Path -File |
             Where-Object { $_.Extension -match '^\.(jpe?g|png|bmp|webp)$' -and
                            $_.BaseName -notmatch '(?i)(-photoroom|-ref|_ref)$' }
    $baseDir = $item.FullName
} else {
    $files = @($item)
    $baseDir = $item.DirectoryName
}
if (-not $files) { throw "Khong tim thay anh nao trong: $Path" }

if (-not $OutDir) { $OutDir = Join-Path $baseDir 'output' }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

# ---------- quy doi vien mm -> pixel ----------
$radius = if ($OutlinePx -gt 0) { $OutlinePx } else { $OutlineMm / 25.4 * $Dpi }
try { $oc = [System.Drawing.ColorTranslator]::FromHtml($OutlineColor) }
catch { throw "Mau vien khong hop le: '$OutlineColor'. Dung ten mau (White, Black) hoac ma hex (#FFFFFF)." }

Write-Host ""
Write-Host "Nguong: TLow=$TLow  THigh=$THigh   ->  $OutDir" -ForegroundColor DarkGray
if ($radius -ge 0.5) {
    $mmShown = [math]::Round($radius / $Dpi * 25.4, 2)
    Write-Host ("Vien: {0} mm = {1} px  @ {2} DPI   mau {3}   do min x{4}" -f `
        $mmShown, [math]::Round($radius,1), $Dpi, $OutlineColor, $OutlineQuality) -ForegroundColor DarkGray
}
Write-Host ""

foreach ($f in $files) {
    $name    = [System.IO.Path]::GetFileNameWithoutExtension($f.Name)
    $outPng  = Join-Path $OutDir "$name.png"
    $preview = if ($NoPreview) { $null } else { Join-Path $OutDir "$name._preview.png" }

    $hMean = if ($ReportOnly) { -1 } else { $HoleMaxMean }
    $hStd  = if ($ReportOnly) { -1 } else { $HoleMaxStd }

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $st = [BgRemover]::Run($f.FullName, $outPng, $preview, $TLow, $THigh, $hMean, $hStd, $HoleMinArea, $HoleMaxShell, `
                           $radius, [int]$oc.R, [int]$oc.G, [int]$oc.B, $OutlineQuality, `
                           $Smooth, $EdgeMid, $MinIsland, $Stage, $EdgeSoft, $Smoothstep)
    $sw.Stop()

    $pctT = [math]::Round(100.0 * $st.TransparentPx / $st.TotalPx, 1)
    $pctP = [math]::Round(100.0 * $st.PartialPx     / $st.TotalPx, 2)

    Write-Host ("{0,-46} {1,6}ms" -f $name, $sw.ElapsedMilliseconds) -ForegroundColor Green
    $haloCol = if ($st.HaloPx -eq 0) { 'DarkGray' } else { 'Yellow' }
    Write-Host ("   nen=({0},{1},{2})  trong suot={3}%  bien mem={4}%  quang={5}px  dao vun={6}  gam mep={7}px" -f `
        $st.BgR, $st.BgG, $st.BgB, $pctT, $pctP, $st.HaloPx, $st.IslandsRemoved, $st.TrimmedPx) -ForegroundColor $haloCol

    if ($st.Holes.Count) {
        Write-Host ("   {0,-8} {1,-22} {2,7} {3,7} {4,7}   vung sang bi bao kin" -f 'dientich','vi tri (x,y,rong,cao)','mean','std','vo(px)') -ForegroundColor DarkGray
        foreach ($hl in $st.Holes) {
            $tag = if ($hl.Punched) { 'DUC THUNG' } else { 'giu dac ' }
            $col = if ($hl.Punched) { 'Yellow' } else { 'DarkGray' }
            Write-Host ("   {0,-8} {1,-22} {2,7:N2} {3,7:N2} {4,7:N1}   {5}" -f `
                $hl.Area, "$($hl.X0),$($hl.Y0),$($hl.X1-$hl.X0+1),$($hl.Y1-$hl.Y0+1)", `
                $hl.MeanDist, $hl.StdDist, $hl.ShellPx, $tag) -ForegroundColor $col
        }
    }
}

Write-Host ""
Write-Host "Xong. Mo file *._preview.png de soi lo thung tren nen caro." -ForegroundColor Cyan

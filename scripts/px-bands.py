# Mean brightness of horizontal bands in a PNG — the only way to tell "the dim covers the screen" from
# "the dim covers most of the screen". Written because a reported bright strip at the top of the tutorial
# could not be settled by looking at screenshots: the strip and the stage differ by ~2x in the numbers and
# by very little to the eye. Pure stdlib (zlib + an unfilter loop), no image dependency.
# Usage: python3 scripts/px-bands.py shot.png
import sys, zlib, struct
def load(path):
    d = open(path,'rb').read(); assert d[:8]==b'\x89PNG\r\n\x1a\n'
    i=8; w=h=None; idat=b''; bd=ct=None
    while i < len(d):
        ln = struct.unpack('>I', d[i:i+4])[0]; typ = d[i+4:i+8]; data = d[i+8:i+8+ln]; i += 12+ln
        if typ==b'IHDR': w,h,bd,ct = struct.unpack('>IIBB', data[:10])
        elif typ==b'IDAT': idat += data
        elif typ==b'IEND': break
    assert bd==8 and ct in (2,6), f'bit depth {bd} colour type {ct}'
    ch = 3 if ct==2 else 4
    raw = zlib.decompress(idat); stride = w*ch; out=bytearray(); prev=bytearray(stride); p=0
    for _ in range(h):
        f = raw[p]; p+=1; line = bytearray(raw[p:p+stride]); p+=stride
        if f==1:
            for x in range(ch,stride): line[x]=(line[x]+line[x-ch])&255
        elif f==2:
            for x in range(stride): line[x]=(line[x]+prev[x])&255
        elif f==3:
            for x in range(stride): line[x]=(line[x]+((line[x-ch] if x>=ch else 0)+prev[x])//2)&255
        elif f==4:
            for x in range(stride):
                a=line[x-ch] if x>=ch else 0; b=prev[x]; c=prev[x-ch] if x>=ch else 0
                pp=a+b-c; pa,pb,pc=abs(pp-a),abs(pp-b),abs(pp-c)
                line[x]=(line[x]+(a if (pa<=pb and pa<=pc) else b if pb<=pc else c))&255
        out+=line; prev=line
    return w,h,ch,bytes(out)
def band(w,h,ch,px,y0,y1):
    tot=n=0
    for y in range(max(0,y0), min(h,y1)):
        for x in range(0, w, 4):
            o=(y*w+x)*ch; tot += (px[o]+px[o+1]+px[o+2])/3; n+=1
    return tot/max(1,n)
w,h,ch,px = load(sys.argv[1])
print(f'{sys.argv[1]}  {w}x{h}')
for label,y0,y1 in [('top 0-20',0,20),('top 20-44',20,44),('stage 60-100',60,100),('mid 200-240',200,240),('bottom-8',h-8,h)]:
    print(f'   {label:14s} mean brightness {band(w,h,ch,px,y0,y1):6.1f}')

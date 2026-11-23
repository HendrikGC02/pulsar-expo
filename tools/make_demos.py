"""Cut demo filterbanks: copy the SIGPROC header + the first N seconds of data.

usage: python make_demos.py SRC.fil OUT.fil [seconds]   (no seconds = whole file)
       python make_demos.py --info SRC.fil
"""
import os, struct, sys

INT = {'telescope_id','machine_id','data_type','barycentric','pulsarcentric','nbits','nsamples',
       'nchans','nifs','nbeams','ibeam','nbins'}
DBL = {'az_start','za_start','src_raj','src_dej','tstart','tsamp','fch1','foff','refdm','period'}

def read_header(f):
    def s():
        n = struct.unpack('<i', f.read(4))[0]; return f.read(n).decode('latin1')
    if s() != 'HEADER_START': raise ValueError('not a SIGPROC filterbank')
    h, pos = {}, {}
    while True:
        k = s()
        if k == 'HEADER_END': break
        pos[k] = f.tell()
        if k in INT: h[k] = struct.unpack('<i', f.read(4))[0]
        elif k in DBL: h[k] = struct.unpack('<d', f.read(8))[0]
        else: h[k] = s()
    return h, pos, f.tell()

def main(a):
    if a[0] == '--info':
        with open(a[1], 'rb') as f: h, _, hl = read_header(f)
        size = os.path.getsize(a[1]); bps = h['nchans'] * h.get('nifs', 1) * h['nbits'] // 8
        print(a[1], {k: h[k] for k in ('source_name','nchans','nbits','tsamp','fch1','foff') if k in h},
              'hdr', hl, 'dur %.2f s' % ((size - hl) / bps * h['tsamp']), 'MB/s %.2f' % (bps / h['tsamp'] / 1e6))
        return
    src, out = a[0], a[1]
    with open(src, 'rb') as f:
        h, pos, hl = read_header(f)
        bps = h['nchans'] * h.get('nifs', 1) * h['nbits'] // 8
        total = (os.path.getsize(src) - hl) // bps
        n = total if len(a) < 3 else min(total, int(round(float(a[2]) / h['tsamp'])))
        f.seek(0); head = bytearray(f.read(hl))
        if 'nsamples' in pos: struct.pack_into('<i', head, pos['nsamples'], n)
        with open(out, 'wb') as o:
            o.write(head); left = n * bps
            while left:
                b = f.read(min(left, 1 << 24)); o.write(b); left -= len(b)
    print(f'{out}: {n} samples, {n * h["tsamp"]:.3f} s, {os.path.getsize(out) / 1e6:.1f} MB')

if __name__ == '__main__': main(sys.argv[1:])

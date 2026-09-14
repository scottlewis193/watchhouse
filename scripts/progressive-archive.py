#!/usr/bin/env python3
"""Read a seekable localhost archive and extract one video to a growing file.

Only explicitly registered archive formats are supported. Entry paths are never
used as output paths. stdout contains bounded JSON status, never video bytes.
"""
import ctypes as C
import ctypes.util
import json
import os
import sys
import urllib.request


def emit(**event):
    print(json.dumps(event), flush=True)


def main():
    # Bound native decompressor allocation; oversized dictionaries fall back to
    # the existing full-download tooling rather than exhausting the app host.
    try:
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (1024 * 1024 * 1024, 1024 * 1024 * 1024))
    except (ImportError, ValueError, OSError):
        pass
    url, output, total = sys.argv[1], sys.argv[2], int(sys.argv[3])
    lib = C.CDLL(ctypes.util.find_library('archive') or 'libarchive.so.13')
    ptr = C.c_void_p
    def api(name, restype, *args):
        fn = getattr(lib, name)
        fn.restype, fn.argtypes = restype, list(args)
        return fn
    new = api('archive_read_new', ptr)
    free = api('archive_read_free', C.c_int, ptr)
    error = api('archive_error_string', C.c_char_p, ptr)
    next_header = api('archive_read_next_header', C.c_int, ptr, C.POINTER(ptr))
    skip_data = api('archive_read_data_skip', C.c_int, ptr)
    read_data = api('archive_read_data', C.c_ssize_t, ptr, ptr, C.c_size_t)
    pathname = api('archive_entry_pathname', C.c_char_p, ptr)
    size = api('archive_entry_size', C.c_int64, ptr)
    filetype = api('archive_entry_filetype', C.c_uint, ptr)
    encrypted = api('archive_entry_is_encrypted', C.c_int, ptr)
    OPEN = C.CFUNCTYPE(C.c_int, ptr, ptr)
    READ = C.CFUNCTYPE(C.c_ssize_t, ptr, ptr, C.POINTER(ptr))
    SKIP = C.CFUNCTYPE(C.c_int64, ptr, ptr, C.c_int64)
    SEEK = C.CFUNCTYPE(C.c_int64, ptr, ptr, C.c_int64, C.c_int)
    CLOSE = C.CFUNCTYPE(C.c_int, ptr, ptr)
    open2 = api('archive_read_open2', C.c_int, ptr, ptr, OPEN, READ, SKIP, CLOSE)
    set_seek = api('archive_read_set_seek_callback', C.c_int, ptr, SEEK)
    position, buffer, read_error = 0, None, None
    read_size = 64 * 1024
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    @OPEN
    def opened(a, data):
        return 0

    @CLOSE
    def closed(a, data):
        return 0

    @READ
    def read(a, data, target):
        nonlocal position, buffer, read_error
        try:
            if position >= total:
                return 0
            end = min(total, position + read_size) - 1
            request = urllib.request.Request(url, headers={'Range': f'bytes={position}-{end}'})
            with opener.open(request, timeout=30) as response:
                if response.status != 206:
                    raise RuntimeError('Archive byte-range request failed')
                payload = response.read(end - position + 2)
            if len(payload) != end - position + 1:
                raise RuntimeError('Incomplete archive byte range')
            buffer = C.create_string_buffer(payload)
            # The buffer is held until the next read. Passing its address
            # avoids ctypes cast ownership cycles retaining old 4 MiB buffers.
            target[0] = C.addressof(buffer)
            position += len(payload)
            return len(payload)
        except Exception as exc:
            read_error = str(exc)
            return -1

    @SKIP
    def skip(a, data, amount):
        nonlocal position
        count = min(max(0, amount), total - position)
        position += count
        return count

    @SEEK
    def seek(a, data, offset, whence):
        nonlocal position
        dest = offset if whence == 0 else position + offset if whence == 1 else total + offset
        if dest < 0 or dest > total:
            return -1
        position = dest
        return dest

    def check(a, result):
        if result < 0:
            raise RuntimeError(read_error or (error(a) or b'Archive inspection failed').decode('utf-8', 'replace'))
        return result

    def reader():
        nonlocal position, read_error
        position, read_error = 0, None
        a = new()
        try:
            check(a, api('archive_read_support_format_7zip', C.c_int, ptr)(a))
            check(a, api('archive_read_support_format_zip', C.c_int, ptr)(a))
            check(a, api('archive_read_support_format_rar', C.c_int, ptr)(a))
            check(a, api('archive_read_support_format_rar5', C.c_int, ptr)(a))
            check(a, set_seek(a, seek))
            check(a, open2(a, None, opened, read, skip, closed))
            return a
        except Exception:
            free(a)
            raise

    # Select the largest regular video, so a sample/cover cannot win by order.
    a, selected, index = reader(), None, 0
    try:
        while True:
            entry = ptr()
            result = check(a, next_header(a, C.byref(entry)))
            if result == 1:
                break
            name = (pathname(entry) or b'').decode('utf-8', 'replace')
            length = size(entry)
            if filetype(entry) == 0o100000 and os.path.splitext(name)[1].lower() in ('.mkv', '.mp4', '.m4v', '.mov', '.webm'):
                if encrypted(entry):
                    raise RuntimeError('Encrypted video requires full archive preparation')
                if length > 0 and (selected is None or length > selected['size']):
                    selected = {'index': index, 'name': os.path.basename(name), 'size': length}
            check(a, skip_data(a))
            index += 1
            if index > 10000:
                raise RuntimeError('Too many archive entries')
    finally:
        free(a)
    if selected is None:
        raise RuntimeError('No supported video found in archive')
    emit(type='metadata', **selected)
    a = reader()
    try:
        for index in range(selected['index'] + 1):
            entry = ptr()
            if check(a, next_header(a, C.byref(entry))) == 1:
                raise RuntimeError('Video entry disappeared')
            if index != selected['index']:
                check(a, skip_data(a))
        read_size = 4 * 1024 * 1024
        block, written = C.create_string_buffer(256 * 1024), 0
        with open(output, 'wb') as target:
            while True:
                count = check(a, read_data(a, block, len(block)))
                if count == 0:
                    break
                target.write(block.raw[:count])
                target.flush()
                written += count
                if written > selected['size']:
                    raise RuntimeError('Archive video exceeded its declared size')
                emit(type='progress', bytes=written)
        if written != selected['size']:
            raise RuntimeError('Archive video is truncated')
        emit(type='complete', bytes=written)
    finally:
        free(a)


try:
    main()
except Exception as exc:
    emit(type='error', message=str(exc)[:500])
    sys.exit(1)

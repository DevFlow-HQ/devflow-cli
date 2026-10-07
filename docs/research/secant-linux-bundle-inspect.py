"""Read Bun 1.4.2 module metadata without executing the artifact."""
from pathlib import Path
import hashlib
import json
import struct
import sys

binary = Path(sys.argv[1]).read_bytes()
assert binary[:6] == b"\x7fELF\x02\x01"
section_offset = struct.unpack_from("<Q", binary, 40)[0]
section_size, section_count, names_index = struct.unpack_from("<HHH", binary, 58)
headers = [struct.unpack_from("<IIQQQQIIQQ", binary, section_offset + i * section_size)
           for i in range(section_count)]
names_header = headers[names_index]
names = binary[names_header[4]:names_header[4] + names_header[5]]
bun_header = next(h for h in headers if names[h[0]:].split(b"\0", 1)[0] == b".bun")
section = binary[bun_header[4]:bun_header[4] + bun_header[5]]
graph_size = struct.unpack_from("<Q", section)[0]
graph = section[8:8 + graph_size]
trailer = b"\n---- Bun! ----\n"
assert graph.endswith(trailer)
byte_count, modules_offset, modules_size, entry_id, _, _, flags = struct.unpack_from(
    "<QIIIIII", graph, len(graph) - len(trailer) - 32)
assert byte_count == len(graph) - len(trailer) - 32 and modules_size % 52 == 0
modules = []
for index in range(modules_size // 52):
    no, nl, co, cl, so, sl, bo, bl, _, _, _, _, encoding, loader, fmt, side = struct.unpack_from(
        "<12I4B", graph, modules_offset + index * 52)
    assert max(no + nl, co + cl, so + sl, bo + bl) <= byte_count
    content = graph[co:co + cl]
    modules.append({"id": index, "name": graph[no:no + nl].decode(),
                    "contentBytes": cl, "bytecodeBytes": bl, "sourcemapBytes": sl,
                    "sha256": hashlib.sha256(content).hexdigest(),
                    "containsSecantApplicationPaths": b"// src/application/" in content})
print(json.dumps({"binarySha256": hashlib.sha256(binary).hexdigest(),
                  "graphBytes": len(graph), "entryId": entry_id, "flags": flags,
                  "modules": modules}, indent=2))

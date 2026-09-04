import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, readSync, writeSync } from "node:fs";
import { lstat, open, readFile, stat } from "node:fs/promises";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

const ACQUISITION_CONTROLLER_LENGTH = 9_956;
const ACQUISITION_CONTROLLER_SHA256 =
  "72290e827399c5e6eb4c597312a65fbd6402c2d8ad87993c7e336a27f6d48258";
const PROOF_CONTROLLER_LENGTH = 30_322;
const PROOF_CONTROLLER_SHA256 =
  "914feaa7cece86e66a81a4dd8595d7efc2ae2e7be241d6190aee97c5c213bfcb";

const ACQUISITION_CONTROLLER_BASE64 = Object.freeze([
  "IyEvYmluL2Jhc2gKc2V0IC1ldW8gcGlw",
  "ZWZhaWwKdW1hc2sgMDc3CltbICQjIC1l",
  "cSAwIF1dCgphdXRob3JpdHlfbGVkZ2Vy",
  "KCkgewogIGxvY2FsIHJvb3Q9JDEKICBs",
  "b2NhbCBvdXRwdXQ9JDIKICBsb2NhbCBr",
  "ZXllZD0ke291dHB1dH0ua2V5ZWQKICBs",
  "b2NhbCByb3dzPSR7b3V0cHV0fS5yb3dz",
  "CiAgbG9jYWwgYm9keT0ke291dHB1dH0u",
  "Ym9keQogIGxvY2FsIHBhdGggcmVsYXRp",
  "dmUgbG9naWNhbCBtb2RlIHNpemUgZGln",
  "ZXN0CiAgbG9jYWwgcmVjb3Jkcz0wIGZp",
  "bGVzPTAgZGlyZWN0b3JpZXM9MCBieXRl",
  "cz0wCiAgOiA+IiRrZXllZCIKICB3aGls",
  "ZSBJRlM9IHJlYWQgLXIgLWQgJycgcGF0",
  "aDsgZG8KICAgIFtbIC1kICIkcGF0aCIg",
  "JiYgISAtTCAiJHBhdGgiIF1dCiAgICBy",
  "ZWxhdGl2ZT0ke3BhdGgjIiRyb290In0K",
  "ICAgIHJlbGF0aXZlPSR7cmVsYXRpdmUj",
  "L30KICAgIGlmIFtbIC1uICIkcmVsYXRp",
  "dmUiIF1dOyB0aGVuCiAgICAgIFtbICIk",
  "cmVsYXRpdmUiID1+IF5bQS1aYS16MC05",
  "Ll8rQC8tXSskIF1dCiAgICAgIGxvZ2lj",
  "YWw9dG9vbGNoYWluLyRyZWxhdGl2ZQog",
  "ICAgZWxzZQogICAgICBsb2dpY2FsPXRv",
  "b2xjaGFpbgogICAgZmkKICAgIHByaW50",
  "ZiAnRFx0JXNcdERcdDA1NTVcdCVzXG4n",
  "ICIkbG9naWNhbCIgIiRsb2dpY2FsIiA+",
  "PiIka2V5ZWQiCiAgICAoKHJlY29yZHMg",
  "Kz0gMSwgZGlyZWN0b3JpZXMgKz0gMSkp",
  "CiAgZG9uZSA8IDwoL3Vzci9iaW4vZmlu",
  "ZCAiJHJvb3QiIC14ZGV2IC10eXBlIGQg",
  "LXByaW50MCkKICB3aGlsZSBJRlM9IHJl",
  "YWQgLXIgLWQgJycgcGF0aDsgZG8KICAg",
  "IFtbIC1mICIkcGF0aCIgJiYgISAtTCAi",
  "JHBhdGgiIF1dCiAgICBbWyAkKC91c3Iv",
  "YmluL3N0YXQgLWMgJyVoJyAtLSAiJHBh",
  "dGgiKSA9PSAxIF1dCiAgICByZWxhdGl2",
  "ZT0ke3BhdGgjIiRyb290Ii99CiAgICBb",
  "WyAtbiAiJHJlbGF0aXZlIiAmJiAiJHJl",
  "bGF0aXZlIiA9fiBeW0EtWmEtejAtOS5f",
  "K0AvLV0rJCBdXQogICAgbW9kZT0wNDQ0",
  "CiAgICBpZiAoKCAoOCMkKC91c3IvYmlu",
  "L3N0YXQgLWMgJyVhJyAtLSAiJHBhdGgi",
  "KSAmIDgjMTExKSAhPSAwICkpOyB0aGVu",
  "CiAgICAgIG1vZGU9MDU1NQogICAgZmkK",
  "ICAgIHNpemU9JCgvdXNyL2Jpbi9zdGF0",
  "IC1jICclcycgLS0gIiRwYXRoIikKICAg",
  "IGRpZ2VzdD0kKC91c3IvYmluL3NoYTI1",
  "NnN1bSAtLSAiJHBhdGgiKQogICAgZGln",
  "ZXN0PSR7ZGlnZXN0JSUgKn0KICAgIHBy",
  "aW50ZiAnVFx0JXNcdFRcdCVzXHQlc1x0",
  "JXNcdCVzXG4nIFwKICAgICAgIiRyZWxh",
  "dGl2ZSIgIiRtb2RlIiAiJHNpemUiICIk",
  "ZGlnZXN0IiAiJHJlbGF0aXZlIiA+PiIk",
  "a2V5ZWQiCiAgICAoKHJlY29yZHMgKz0g",
  "MSwgZmlsZXMgKz0gMSwgYnl0ZXMgKz0g",
  "c2l6ZSkpCiAgZG9uZSA8IDwoL3Vzci9i",
  "aW4vZmluZCAiJHJvb3QiIC14ZGV2IC10",
  "eXBlIGYgLXByaW50MCkKICBbWyAteiAk",
  "KC91c3IvYmluL2ZpbmQgIiRyb290IiAt",
  "eGRldiAhIC10eXBlIGQgISAtdHlwZSBm",
  "IC1wcmludCAtcXVpdCkgXV0KICBMQU5H",
  "PUMgL3Vzci9iaW4vc29ydCAtbyAiJGtl",
  "eWVkIiAiJGtleWVkIgogIC91c3IvYmlu",
  "L2N1dCAtZjMtICIka2V5ZWQiID4iJHJv",
  "d3MiCiAgewogICAgcHJpbnRmICdvcGVu",
  "c3BlbGwud3AyMDEudG9vbGNoYWluLWF1",
  "dGhvcml0eS52MVxucmVjb3Jkc1x0JXNc",
  "bicgIiRyZWNvcmRzIgogICAgL3Vzci9i",
  "aW4vY2F0ICIkcm93cyIKICB9ID4iJGJv",
  "ZHkiCiAgZGlnZXN0PSQoL3Vzci9iaW4v",
  "c2hhMjU2c3VtIC0tICIkYm9keSIpCiAg",
  "ZGlnZXN0PSR7ZGlnZXN0JSUgKn0KICB7",
  "CiAgICAvdXNyL2Jpbi9jYXQgIiRib2R5",
  "IgogICAgcHJpbnRmICdlbmRcdCVzXG4n",
  "ICIkZGlnZXN0IgogIH0gPiIkb3V0cHV0",
  "IgogIC91c3IvYmluL3JtIC0tICIka2V5",
  "ZWQiICIkcm93cyIgIiRib2R5IgogIHBy",
  "aW50ZiAnJXMgJXMgJXMgJXMgJXNcbicg",
  "IiRmaWxlcyIgIiRkaXJlY3RvcmllcyIg",
  "IiRieXRlcyIgIiRyZWNvcmRzIiAiJCgv",
  "dXNyL2Jpbi9zdGF0IC1jICclcycgLS0g",
  "IiRvdXRwdXQiKSIKfQoKcmVxdWlyZV9h",
  "dXRob3JpdHkoKSB7CiAgbG9jYWwgcm9v",
  "dD0kMQogIGxvY2FsIG91dHB1dD0kMgog",
  "IGxvY2FsIGV4cGVjdGVkX3N0YXRzPSQz",
  "CiAgbG9jYWwgZXhwZWN0ZWRfZGlnZXN0",
  "PSQ0CiAgW1sgJChhdXRob3JpdHlfbGVk",
  "Z2VyICIkcm9vdCIgIiRvdXRwdXQiKSA9",
  "PSAiJGV4cGVjdGVkX3N0YXRzIiBdXQog",
  "IGxvY2FsIGFjdHVhbD0kKC91c3IvYmlu",
  "L3NoYTI1NnN1bSAtLSAiJG91dHB1dCIp",
  "CiAgW1sgJHthY3R1YWwlJSAqfSA9PSAi",
  "JGV4cGVjdGVkX2RpZ2VzdCIgXV0KfQoK",
  "cmVxdWlyZV9zb3VyY2VfaW5wdXQoKSB7",
  "CiAgbG9jYWwgcGF0aD0kMQogIGxvY2Fs",
  "IHNpemU9JDIKICBsb2NhbCBkaWdlc3Q9",
  "JDMKICBbWyAtZiAiJHBhdGgiICYmICEg",
  "LUwgIiRwYXRoIiBdXQogIFtbICQoL3Vz",
  "ci9iaW4vc3RhdCAtYyAnJWE6JWg6JXMn",
  "IC0tICIkcGF0aCIpID09ICI0NDQ6MTok",
  "c2l6ZSIgXV0KICBsb2NhbCBhY3R1YWw9",
  "JCgvdXNyL2Jpbi9zaGEyNTZzdW0gLS0g",
  "IiRwYXRoIikKICBbWyAke2FjdHVhbCUl",
  "ICp9ID09ICIkZGlnZXN0IiBdXQp9Cgpy",
  "ZXF1aXJlX3NvdXJjZV9pbnB1dCAvaW5w",
  "dXQvc291cmNlL3Rvb2xzL2hvc3RlZC1t",
  "aWdyYXRpb24tcHJlcGFyYXRpb24tcHJv",
  "b2YvQ2FyZ28udG9tbCA1NTggXAogIDVj",
  "ODllMTZjYWM0NzIxZjRhOTY4YjIwODll",
  "ZmNlYThmYjljMWZlOTgyMjVkNjk3OTE2",
  "NmUyYzJhMzQ2MWJhZDkKcmVxdWlyZV9z",
  "b3VyY2VfaW5wdXQgL2lucHV0L3NvdXJj",
  "ZS90b29scy9ob3N0ZWQtbWlncmF0aW9u",
  "LXByZXBhcmF0aW9uLXByb29mL0Nhcmdv",
  "LmxvY2sgMTUyMDggXAogIGYzNDU1Nzc0",
  "OTI2ODgwOTE5NTg4MjQ2YmM5ZmM0MjJl",
  "M2VjZTEzYzI5MjUwODYyYjQyNDliOTFi",
  "NTVlY2JjODYKcmVxdWlyZV9zb3VyY2Vf",
  "aW5wdXQgL2lucHV0L3NvdXJjZS90b29s",
  "cy9ob3N0ZWQtbWlncmF0aW9uLXByZXBh",
  "cmF0aW9uLXByb29mL3J1c3QtdG9vbGNo",
  "YWluLnRvbWwgODYgXAogIDhlMzkwZDZh",
  "MDgzODMxNWY5NzI2OTBmNDZlZjhiYWU4",
  "YjdlY2M5ZWU2YzFlZDcwMTQwZWY4NTI4",
  "NjljMjQ4MmUKcmVxdWlyZV9zb3VyY2Vf",
  "aW5wdXQgL2lucHV0L3NvdXJjZS90b29s",
  "cy9ob3N0ZWQtbWlncmF0aW9uLXJvb3Qt",
  "YXV0aG9yaXR5L0NhcmdvLnRvbWwgNzg3",
  "IFwKICA3NjM5ZTJmNTliYjBjNzQ1YjU0",
  "YTE5MjQ3OGQ4NmJiYTFhYjFhMDQ2MDY2",
  "ZWE0OTBlZmE2Yjc4M2U0ZTI4NjBhCnJl",
  "cXVpcmVfc291cmNlX2lucHV0IC9pbnB1",
  "dC9zb3VyY2UvdG9vbHMvaG9zdGVkLW1p",
  "Z3JhdGlvbi1yb290LWF1dGhvcml0eS9D",
  "YXJnby5sb2NrIDEzNzQxIFwKICBiZDQ2",
  "MGI0Y2E5YjA2MjQxYTM5M2ViOWQ0YjVi",
  "Y2MwNWI2OGE2ZDZhZjg0NGZhYjFmOWE2",
  "ODM4MjY5NzlmNmY1CnJlcXVpcmVfc291",
  "cmNlX2lucHV0IC9pbnB1dC9zb3VyY2Uv",
  "dG9vbHMvaG9zdGVkLW1pZ3JhdGlvbi1y",
  "b290LWF1dGhvcml0eS9ydXN0LXRvb2xj",
  "aGFpbi50b21sIDg2IFwKICA4ZTM5MGQ2",
  "YTA4MzgzMTVmOTcyNjkwZjQ2ZWY4YmFl",
  "OGI3ZWNjOWVlNmMxZWQ3MDE0MGVmODUy",
  "ODY5YzI0ODJlCnJlcXVpcmVfc291cmNl",
  "X2lucHV0IC9pbnB1dC9zb3VyY2UvdG9v",
  "bHMvaG9zdGVkLW1pZ3JhdGlvbi1ydW50",
  "aW1lLXByb29mL0NhcmdvLnRvbWwgMTA0",
  "NyBcCiAgY2ZjYTMzYWQ4YTYyMWYzMGZk",
  "NTRjNGE5ODQzZWIxZGQyYWRkOGE5MWNi",
  "NGQ3ODVjNjBjYWJkNGNjYjk0NTM2NApy",
  "ZXF1aXJlX3NvdXJjZV9pbnB1dCAvaW5w",
  "dXQvc291cmNlL3Rvb2xzL2hvc3RlZC1t",
  "aWdyYXRpb24tcnVudGltZS1wcm9vZi9D",
  "YXJnby5sb2NrIDE1NDkzIFwKICA1OGUz",
  "YzAwYjU1OGFmMDNkYjk2NTE2ZTdlNjJm",
  "NWRmMTcwNjMwYTI4YTljMjkzOTViMWUx",
  "ZGU0NzdhODJmNmFhCnJlcXVpcmVfc291",
  "cmNlX2lucHV0IC9pbnB1dC9zb3VyY2Uv",
  "dG9vbHMvaG9zdGVkLW1pZ3JhdGlvbi1y",
  "dW50aW1lLXByb29mL3J1c3QtdG9vbGNo",
  "YWluLnRvbWwgODYgXAogIDhlMzkwZDZh",
  "MDgzODMxNWY5NzI2OTBmNDZlZjhiYWU4",
  "YjdlY2M5ZWU2YzFlZDcwMTQwZWY4NTI4",
  "NjljMjQ4MmUKCm5vcm1hbGl6ZV90cmVl",
  "KCkgewogIGxvY2FsIHJvb3Q9JDEKICBs",
  "b2NhbCBraW5kPSQyCiAgbG9jYWwgcGF0",
  "aCBtb2RlIHVpZF9naWQKICB3aGlsZSBJ",
  "RlM9IHJlYWQgLXIgLWQgJycgcGF0aDsg",
  "ZG8KICAgIFtbIC1kICIkcGF0aCIgJiYg",
  "ISAtTCAiJHBhdGgiIF1dCiAgICB1aWRf",
  "Z2lkPSQoL3Vzci9iaW4vc3RhdCAtYyAn",
  "JXU6JWcnIC0tICIkcGF0aCIpCiAgICBb",
  "WyAiJHVpZF9naWQiID09ICIkKC91c3Iv",
  "YmluL2lkIC11KTokKC91c3IvYmluL2lk",
  "IC1nKSIgXV0KICAgIG1vZGU9JCgvdXNy",
  "L2Jpbi9zdGF0IC1jICclYScgLS0gIiRw",
  "YXRoIikKICAgICgoICg4IyRtb2RlICYg",
  "OCM3MDApID09IDgjNzAwICkpCiAgICAo",
  "KCAoOCMkbW9kZSAmIDgjNzAyMikgPT0g",
  "MCApKQogIGRvbmUgPCA8KC91c3IvYmlu",
  "L2ZpbmQgIiRyb290IiAteGRldiAtdHlw",
  "ZSBkIC1wcmludDApCiAgd2hpbGUgSUZT",
  "PSByZWFkIC1yIC1kICcnIHBhdGg7IGRv",
  "CiAgICBbWyAtZiAiJHBhdGgiICYmICEg",
  "LUwgIiRwYXRoIiBdXQogICAgW1sgJCgv",
  "dXNyL2Jpbi9zdGF0IC1jICclaCcgLS0g",
  "IiRwYXRoIikgPT0gMSBdXQogICAgdWlk",
  "X2dpZD0kKC91c3IvYmluL3N0YXQgLWMg",
  "JyV1OiVnJyAtLSAiJHBhdGgiKQogICAg",
  "W1sgIiR1aWRfZ2lkIiA9PSAiJCgvdXNy",
  "L2Jpbi9pZCAtdSk6JCgvdXNyL2Jpbi9p",
  "ZCAtZykiIF1dCiAgICBtb2RlPSQoL3Vz",
  "ci9iaW4vc3RhdCAtYyAnJWEnIC0tICIk",
  "cGF0aCIpCiAgICAoKCAoOCMkbW9kZSAm",
  "IDgjNjAwKSA9PSA4IzYwMCApKQogICAg",
  "KCggKDgjJG1vZGUgJiA4IzcwMjIpID09",
  "IDAgKSkKICAgIGlmIFtbICIka2luZCIg",
  "PT0gdG9vbGNoYWluICYmICQoKDgjJG1v",
  "ZGUgJiA4IzExMSkpIC1uZSAwIF1dOyB0",
  "aGVuCiAgICAgIC91c3IvYmluL2NobW9k",
  "IDA1NTUgLS0gIiRwYXRoIgogICAgZWxz",
  "ZQogICAgICAvdXNyL2Jpbi9jaG1vZCAw",
  "NDQ0IC0tICIkcGF0aCIKICAgIGZpCiAg",
  "ZG9uZSA8IDwoL3Vzci9iaW4vZmluZCAi",
  "JHJvb3QiIC14ZGV2IC10eXBlIGYgLXBy",
  "aW50MCkKICBbWyAteiAkKC91c3IvYmlu",
  "L2ZpbmQgIiRyb290IiAteGRldiAhIC10",
  "eXBlIGQgISAtdHlwZSBmIC1wcmludCAt",
  "cXVpdCkgXV0KICB3aGlsZSBJRlM9IHJl",
  "YWQgLXIgLWQgJycgcGF0aDsgZG8KICAg",
  "IC91c3IvYmluL2NobW9kIDA1NTUgLS0g",
  "IiRwYXRoIgogIGRvbmUgPCA8KC91c3Iv",
  "YmluL2ZpbmQgIiRyb290IiAteGRldiAt",
  "ZGVwdGggLXR5cGUgZCAtcHJpbnQwKQp9",
  "CgpyZXF1aXJlX25vcm1hbGl6ZWRfdHJl",
  "ZSgpIHsKICBsb2NhbCByb290PSQxCiAg",
  "bG9jYWwga2luZD0kMgogIGxvY2FsIGV4",
  "cGVjdGVkX2ZpbGVzPSQzCiAgbG9jYWwg",
  "ZXhwZWN0ZWRfZGlyZWN0b3JpZXM9JDQK",
  "ICBsb2NhbCBleHBlY3RlZF9ieXRlcz0k",
  "NQogIGxvY2FsIGZpbGVzIGRpcmVjdG9y",
  "aWVzIGJ5dGVzIHBhdGggbW9kZQogIGZp",
  "bGVzPSQoL3Vzci9iaW4vZmluZCAiJHJv",
  "b3QiIC14ZGV2IC10eXBlIGYgLXByaW50",
  "ZiAuIHwgL3Vzci9iaW4vd2MgLWMpCiAg",
  "ZGlyZWN0b3JpZXM9JCgvdXNyL2Jpbi9m",
  "aW5kICIkcm9vdCIgLXhkZXYgLXR5cGUg",
  "ZCAtcHJpbnRmIC4gfCAvdXNyL2Jpbi93",
  "YyAtYykKICBieXRlcz0kKC91c3IvYmlu",
  "L2ZpbmQgIiRyb290IiAteGRldiAtdHlw",
  "ZSBmIC1wcmludGYgJyVzXG4nIHwgL3Vz",
  "ci9iaW4vYXdrICd7IHRvdGFsICs9ICQx",
  "IH0gRU5EIHsgcHJpbnQgdG90YWwgKyAw",
  "IH0nKQogIFtbICIkZmlsZXMgJGRpcmVj",
  "dG9yaWVzICRieXRlcyIgPT0gIiRleHBl",
  "Y3RlZF9maWxlcyAkZXhwZWN0ZWRfZGly",
  "ZWN0b3JpZXMgJGV4cGVjdGVkX2J5dGVz",
  "IiBdXQogIFtbIC16ICQoL3Vzci9iaW4v",
  "ZmluZCAiJHJvb3QiIC14ZGV2IC10eXBl",
  "IGQgISAtcGVybSAwNTU1IC1wcmludCAt",
  "cXVpdCkgXV0KICBbWyAteiAkKC91c3Iv",
  "YmluL2ZpbmQgIiRyb290IiAteGRldiAh",
  "IC10eXBlIGQgISAtdHlwZSBmIC1wcmlu",
  "dCAtcXVpdCkgXV0KICB3aGlsZSBJRlM9",
  "IHJlYWQgLXIgLWQgJycgcGF0aDsgZG8K",
  "ICAgIFtbIC1mICIkcGF0aCIgJiYgISAt",
  "TCAiJHBhdGgiIF1dCiAgICBbWyAkKC91",
  "c3IvYmluL3N0YXQgLWMgJyVoJyAtLSAi",
  "JHBhdGgiKSA9PSAxIF1dCiAgICBtb2Rl",
  "PSQoL3Vzci9iaW4vc3RhdCAtYyAnJWEn",
  "IC0tICIkcGF0aCIpCiAgICBpZiBbWyAi",
  "JGtpbmQiID09IHRvb2xjaGFpbiBdXTsg",
  "dGhlbgogICAgICBbWyAiJG1vZGUiID09",
  "IDQ0NCB8fCAiJG1vZGUiID09IDU1NSBd",
  "XQogICAgZWxzZQogICAgICBbWyAiJG1v",
  "ZGUiID09IDQ0NCBdXQogICAgZmkKICBk",
  "b25lIDwgPCgvdXNyL2Jpbi9maW5kICIk",
  "cm9vdCIgLXhkZXYgLXR5cGUgZiAtcHJp",
  "bnQwKQp9CgovYmluL21rZGlyIC1wIC9v",
  "dXRwdXQvdG9vbGNoYWluIC9vdXRwdXQv",
  "cnVzdHVwLWNhcmdvIC9vdXRwdXQvY2Fy",
  "Z28taG9tZQpyZXF1aXJlX2F1dGhvcml0",
  "eSAvdXNyL2xvY2FsL3J1c3R1cCAvdG1w",
  "L2Jhc2UubGVkZ2VyICcxNTYgMjYgNjIw",
  "ODQyNTg3IDE4MiAyODU3OScgXAogIGE3",
  "NzAxMGRmMzgxMmRmNDc0Zjk2OGZmM2I3",
  "ZTg1ZWMwZjIzZDZlODE5ZjRmNmQ3ZWE1",
  "Yjk1YjI3NmVmZGM4YTYKL2Jpbi9jcCAt",
  "UiAvdXNyL2xvY2FsL3J1c3R1cC8uIC9v",
  "dXRwdXQvdG9vbGNoYWluLwpyZXF1aXJl",
  "X2F1dGhvcml0eSAvb3V0cHV0L3Rvb2xj",
  "aGFpbiAvdG1wL2NvcGllZC5sZWRnZXIg",
  "JzE1NiAyNiA2MjA4NDI1ODcgMTgyIDI4",
  "NTc5JyBcCiAgYTc3MDEwZGYzODEyZGY0",
  "NzRmOTY4ZmYzYjdlODVlYzBmMjNkNmU4",
  "MTlmNGY2ZDdlYTViOTViMjc2ZWZkYzhh",
  "NgovdXNyL2Jpbi9lbnYgLWkgUEFUSD0v",
  "dXNyL2xvY2FsL2NhcmdvL2JpbjovdXNy",
  "L2JpbjovYmluIEhPTUU9L3dwMjAxLWhv",
  "bWUgQ0FSR09fSE9NRT0vb3V0cHV0L3J1",
  "c3R1cC1jYXJnbyBcCiAgUlVTVFVQX0hP",
  "TUU9L291dHB1dC90b29sY2hhaW4gUlVT",
  "VFVQX05PX1VQREFURV9DSEVDSz0xIExB",
  "Tkc9QyBMQ19BTEw9QyBcCiAgL3Vzci9s",
  "b2NhbC9jYXJnby9iaW4vcnVzdHVwIGNv",
  "bXBvbmVudCBhZGQgXAogIC0tdG9vbGNo",
  "YWluIDEuOTcuMS14ODZfNjQtdW5rbm93",
  "bi1saW51eC1nbnUgcnVzdGZtdCBjbGlw",
  "cHkKcmVxdWlyZV9hdXRob3JpdHkgL291",
  "dHB1dC90b29sY2hhaW4gL3RtcC9maW5h",
  "bC5sZWRnZXIgJzE2OCAyOCA2NTM1NzM1",
  "MjAgMTk2IDMwNTUzJyBcCiAgNjA3OGY0",
  "OWU3MTFjM2E3MDU5ZTExYThhN2IzN2Y1",
  "ZjQ5ODM3Yzc5MjUyM2JkOTE0ZTA1OTJi",
  "NDJkOGYwODdhNAovdXNyL2Jpbi9lbnYg",
  "LWkgUEFUSD0vdXNyL2xvY2FsL2Nhcmdv",
  "L2JpbjovdXNyL2JpbjovYmluIEhPTUU9",
  "L3dwMjAxLWhvbWUgQ0FSR09fSE9NRT0v",
  "b3V0cHV0L2NhcmdvLWhvbWUgXAogIFJV",
  "U1RVUF9IT01FPS9vdXRwdXQvdG9vbGNo",
  "YWluIFJVU1RVUF9UT09MQ0hBSU49MS45",
  "Ny4xLXg4Nl82NC11bmtub3duLWxpbnV4",
  "LWdudSBcCiAgQ0FSR09fVEVSTV9DT0xP",
  "Uj1uZXZlciBMQU5HPUMgTENfQUxMPUMg",
  "L3Vzci9sb2NhbC9jYXJnby9iaW4vY2Fy",
  "Z28gZmV0Y2ggXAogIC0tbWFuaWZlc3Qt",
  "cGF0aCAvaW5wdXQvc291cmNlL3Rvb2xz",
  "L2hvc3RlZC1taWdyYXRpb24tcHJlcGFy",
  "YXRpb24tcHJvb2YvQ2FyZ28udG9tbCAt",
  "LWxvY2tlZAovdXNyL2Jpbi9lbnYgLWkg",
  "UEFUSD0vdXNyL2xvY2FsL2NhcmdvL2Jp",
  "bjovdXNyL2JpbjovYmluIEhPTUU9L3dw",
  "MjAxLWhvbWUgQ0FSR09fSE9NRT0vb3V0",
  "cHV0L2NhcmdvLWhvbWUgXAogIFJVU1RV",
  "UF9IT01FPS9vdXRwdXQvdG9vbGNoYWlu",
  "IFJVU1RVUF9UT09MQ0hBSU49MS45Ny4x",
  "LXg4Nl82NC11bmtub3duLWxpbnV4LWdu",
  "dSBcCiAgQ0FSR09fVEVSTV9DT0xPUj1u",
  "ZXZlciBMQU5HPUMgTENfQUxMPUMgL3Vz",
  "ci9sb2NhbC9jYXJnby9iaW4vY2FyZ28g",
  "ZmV0Y2ggXAogIC0tbWFuaWZlc3QtcGF0",
  "aCAvaW5wdXQvc291cmNlL3Rvb2xzL2hv",
  "c3RlZC1taWdyYXRpb24tcm9vdC1hdXRo",
  "b3JpdHkvQ2FyZ28udG9tbCAtLWxvY2tl",
  "ZAovdXNyL2Jpbi9lbnYgLWkgUEFUSD0v",
  "dXNyL2xvY2FsL2NhcmdvL2JpbjovdXNy",
  "L2JpbjovYmluIEhPTUU9L3dwMjAxLWhv",
  "bWUgQ0FSR09fSE9NRT0vb3V0cHV0L2Nh",
  "cmdvLWhvbWUgXAogIFJVU1RVUF9IT01F",
  "PS9vdXRwdXQvdG9vbGNoYWluIFJVU1RV",
  "UF9UT09MQ0hBSU49MS45Ny4xLXg4Nl82",
  "NC11bmtub3duLWxpbnV4LWdudSBcCiAg",
  "Q0FSR09fVEVSTV9DT0xPUj1uZXZlciBM",
  "QU5HPUMgTENfQUxMPUMgL3Vzci9sb2Nh",
  "bC9jYXJnby9iaW4vY2FyZ28gZmV0Y2gg",
  "XAogIC0tbWFuaWZlc3QtcGF0aCAvaW5w",
  "dXQvc291cmNlL3Rvb2xzL2hvc3RlZC1t",
  "aWdyYXRpb24tcnVudGltZS1wcm9vZi9D",
  "YXJnby50b21sIC0tbG9ja2VkCi91c3Iv",
  "YmluL2VudiAtaSBQQVRIPS91c3IvbG9j",
  "YWwvY2FyZ28vYmluOi91c3IvYmluOi9i",
  "aW4gSE9NRT0vd3AyMDEtaG9tZSBDQVJH",
  "T19IT01FPS9vdXRwdXQvY2FyZ28taG9t",
  "ZSBcCiAgUlVTVFVQX0hPTUU9L291dHB1",
  "dC90b29sY2hhaW4gUlVTVFVQX1RPT0xD",
  "SEFJTj0xLjk3LjEteDg2XzY0LXVua25v",
  "d24tbGludXgtZ251IFwKICBDQVJHT19U",
  "RVJNX0NPTE9SPW5ldmVyIExBTkc9QyBM",
  "Q19BTEw9QyAvdXNyL2xvY2FsL2Nhcmdv",
  "L2Jpbi9jYXJnbyB2ZW5kb3IgXAogIC0t",
  "bWFuaWZlc3QtcGF0aCAvaW5wdXQvc291",
  "cmNlL3Rvb2xzL2hvc3RlZC1taWdyYXRp",
  "b24tcHJlcGFyYXRpb24tcHJvb2YvQ2Fy",
  "Z28udG9tbCBcCiAgLS1zeW5jIC9pbnB1",
  "dC9zb3VyY2UvdG9vbHMvaG9zdGVkLW1p",
  "Z3JhdGlvbi1yb290LWF1dGhvcml0eS9D",
  "YXJnby50b21sIFwKICAtLXN5bmMgL2lu",
  "cHV0L3NvdXJjZS90b29scy9ob3N0ZWQt",
  "bWlncmF0aW9uLXJ1bnRpbWUtcHJvb2Yv",
  "Q2FyZ28udG9tbCBcCiAgLS1sb2NrZWQg",
  "LS12ZXJzaW9uZWQtZGlycyAvb3V0cHV0",
  "L3ZlbmRvciA+L3RtcC92ZW5kb3Iuc3Rk",
  "b3V0CltbIC1mIC90bXAvdmVuZG9yLnN0",
  "ZG91dCAmJiAhIC1MIC90bXAvdmVuZG9y",
  "LnN0ZG91dCBdXQpbWyAkKC91c3IvYmlu",
  "L3N0YXQgLWMgJyV1OiVnOiVoJyAtLSAv",
  "dG1wL3ZlbmRvci5zdGRvdXQpID09ICIk",
  "KC91c3IvYmluL2lkIC11KTokKC91c3Iv",
  "YmluL2lkIC1nKToxIiBdXQpbWyAkKC91",
  "c3IvYmluL3N0YXQgLWMgJyVzJyAtLSAv",
  "dG1wL3ZlbmRvci5zdGRvdXQpIC1sZSA2",
  "NTUzNiBdXQovdXNyL2Jpbi9ybSAtLSAv",
  "dG1wL3ZlbmRvci5zdGRvdXQKL3Vzci9i",
  "aW4vcm0gLS1yZWN1cnNpdmUgLS1mb3Jj",
  "ZSAtLW9uZS1maWxlLXN5c3RlbSAtLSAv",
  "b3V0cHV0L2NhcmdvLWhvbWUgL291dHB1",
  "dC9ydXN0dXAtY2FyZ28KW1sgISAtZSAv",
  "b3V0cHV0L2NhcmdvLWhvbWUgJiYgISAt",
  "ZSAvb3V0cHV0L3J1c3R1cC1jYXJnbyBd",
  "XQpbWyAkKC91c3IvYmluL2ZpbmQgL291",
  "dHB1dCAtbWluZGVwdGggMSAtbWF4ZGVw",
  "dGggMSAtcHJpbnRmICclZlxuJyB8IExB",
  "Tkc9QyAvdXNyL2Jpbi9zb3J0KSA9PSAk",
  "J3Rvb2xjaGFpblxudmVuZG9yJyBdXQpu",
  "b3JtYWxpemVfdHJlZSAvb3V0cHV0L3Zl",
  "bmRvciB2ZW5kb3IKbm9ybWFsaXplX3Ry",
  "ZWUgL291dHB1dC90b29sY2hhaW4gdG9v",
  "bGNoYWluCnJlcXVpcmVfbm9ybWFsaXpl",
  "ZF90cmVlIC9vdXRwdXQvdmVuZG9yIHZl",
  "bmRvciAzNjU3IDk0MSA2NzE1OTEyMQpy",
  "ZXF1aXJlX25vcm1hbGl6ZWRfdHJlZSAv",
  "b3V0cHV0L3Rvb2xjaGFpbiB0b29sY2hh",
  "aW4gMTY4IDI4IDY1MzU3MzUyMApyZXF1",
  "aXJlX2F1dGhvcml0eSAvb3V0cHV0L3Rv",
  "b2xjaGFpbiAvdG1wL25vcm1hbGl6ZWQu",
  "bGVkZ2VyICcxNjggMjggNjUzNTczNTIw",
  "IDE5NiAzMDU1MycgXAogIDYwNzhmNDll",
  "NzExYzNhNzA1OWUxMWE4YTdiMzdmNWY0",
  "OTgzN2M3OTI1MjNiZDkxNGUwNTkyYjQy",
  "ZDhmMDg3YTQKL3Vzci9iaW4vcm0gLS0g",
  "L3RtcC9iYXNlLmxlZGdlciAvdG1wL2Nv",
  "cGllZC5sZWRnZXIgL3RtcC9maW5hbC5s",
  "ZWRnZXIKL3Vzci9iaW4vcm0gLS0gL3Rt",
  "cC9ub3JtYWxpemVkLmxlZGdlcgpwcmlu",
  "dGYgJ29wZW5zcGVsbC53cDIwMS5hY3F1",
  "aXNpdGlvbi1hcmNoaXZlLnYxXG4nCi91",
  "c3IvYmluL3RhciAtLWNyZWF0ZSAtLWZp",
  "bGU9LSAtLWZvcm1hdD11c3RhciAtLWJs",
  "b2NraW5nLWZhY3Rvcj0xIC0tc29ydD1u",
  "YW1lIFwKICAtLW51bWVyaWMtb3duZXIg",
  "LS1vd25lcj0wIC0tZ3JvdXA9MCAtLW10",
  "aW1lPUAwIC0tZGlyZWN0b3J5PS9vdXRw",
  "dXQgdG9vbGNoYWluIHZlbmRvcgo=",
]).join("");
const PROOF_CONTROLLER_BASE64 = Object.freeze([
  "IyEvYmluL2Jhc2gKc2V0IC1ldW8gcGlw",
  "ZWZhaWwKdW1hc2sgMDc3CltbICQjIC1l",
  "cSAxIF1dCnJvd19pZD0kMQoKd3JpdGVf",
  "ZGlyZWN0b3J5X3Jvd3MoKSB7CiAgbG9j",
  "YWwgcm9vdD0kMQogIGxvY2FsIGxvZ2lj",
  "YWxfcm9vdD0kMgogIGxvY2FsIGtleWVk",
  "PSQzCiAgbG9jYWwgcGF0aCByZWxhdGl2",
  "ZSBsb2dpY2FsCiAgd2hpbGUgSUZTPSBy",
  "ZWFkIC1yIC1kICcnIHBhdGg7IGRvCiAg",
  "ICBbWyAtZCAiJHBhdGgiICYmICEgLUwg",
  "IiRwYXRoIiBdXQogICAgW1sgJCgvdXNy",
  "L2Jpbi9zdGF0IC1jICclYScgLS0gIiRw",
  "YXRoIikgPT0gNTU1IF1dCiAgICByZWxh",
  "dGl2ZT0ke3BhdGgjIiRyb290In0KICAg",
  "IHJlbGF0aXZlPSR7cmVsYXRpdmUjL30K",
  "ICAgIGlmIFtbIC1uICIkcmVsYXRpdmUi",
  "IF1dOyB0aGVuCiAgICAgIFtbICIkcmVs",
  "YXRpdmUiID1+IF5bQS1aYS16MC05Ll8r",
  "QC8tXSskIF1dCiAgICAgIGxvZ2ljYWw9",
  "JGxvZ2ljYWxfcm9vdC8kcmVsYXRpdmUK",
  "ICAgIGVsc2UKICAgICAgbG9naWNhbD0k",
  "bG9naWNhbF9yb290CiAgICBmaQogICAg",
  "cHJpbnRmICdEXHQlc1x0RFx0MDU1NVx0",
  "JXNcbicgIiRsb2dpY2FsIiAiJGxvZ2lj",
  "YWwiID4+IiRrZXllZCIKICBkb25lIDwg",
  "PCgvdXNyL2Jpbi9maW5kICIkcm9vdCIg",
  "LXhkZXYgLXR5cGUgZCAtcHJpbnQwKQog",
  "IFtbIC16ICQoL3Vzci9iaW4vZmluZCAi",
  "JHJvb3QiIC14ZGV2ICEgLXR5cGUgZCAh",
  "IC10eXBlIGYgLXByaW50IC1xdWl0KSBd",
  "XQp9Cgp3cml0ZV9maWxlX3Jvd3MoKSB7",
  "CiAgbG9jYWwgdGFnPSQxCiAgbG9jYWwg",
  "cm9vdD0kMgogIGxvY2FsIGtleWVkPSQz",
  "CiAgbG9jYWwgcGF0aCByZWxhdGl2ZSBt",
  "b2RlIHNpemUgZGlnZXN0CiAgd2hpbGUg",
  "SUZTPSByZWFkIC1yIC1kICcnIHBhdGg7",
  "IGRvCiAgICBbWyAtZiAiJHBhdGgiICYm",
  "ICEgLUwgIiRwYXRoIiBdXQogICAgW1sg",
  "JCgvdXNyL2Jpbi9zdGF0IC1jICclaCcg",
  "LS0gIiRwYXRoIikgPT0gMSBdXQogICAg",
  "cmVsYXRpdmU9JHtwYXRoIyIkcm9vdCIv",
  "fQogICAgW1sgLW4gIiRyZWxhdGl2ZSIg",
  "JiYgIiRyZWxhdGl2ZSIgPX4gXltBLVph",
  "LXowLTkuXytALy1dKyQgXV0KICAgIG1v",
  "ZGU9JCgvdXNyL2Jpbi9zdGF0IC1jICcl",
  "YScgLS0gIiRwYXRoIikKICAgIGlmIFtb",
  "ICIkdGFnIiA9PSBUIF1dOyB0aGVuCiAg",
  "ICAgIFtbICIkbW9kZSIgPT0gNDQ0IHx8",
  "ICIkbW9kZSIgPT0gNTU1IF1dCiAgICAg",
  "IG1vZGU9MCRtb2RlCiAgICBlbHNlCiAg",
  "ICAgIFtbICIkbW9kZSIgPT0gNDQ0IF1d",
  "CiAgICAgIG1vZGU9MDQ0NAogICAgZmkK",
  "ICAgIHNpemU9JCgvdXNyL2Jpbi9zdGF0",
  "IC1jICclcycgLS0gIiRwYXRoIikKICAg",
  "IGRpZ2VzdD0kKC91c3IvYmluL3NoYTI1",
  "NnN1bSAtLSAiJHBhdGgiKQogICAgZGln",
  "ZXN0PSR7ZGlnZXN0JSUgKn0KICAgIHBy",
  "aW50ZiAnJXNcdCVzXHQlc1x0JXNcdCVz",
  "XHQlc1x0JXNcbicgXAogICAgICAiJHRh",
  "ZyIgIiRyZWxhdGl2ZSIgIiR0YWciICIk",
  "bW9kZSIgIiRzaXplIiAiJGRpZ2VzdCIg",
  "IiRyZWxhdGl2ZSIgPj4iJGtleWVkIgog",
  "IGRvbmUgPCA8KC91c3IvYmluL2ZpbmQg",
  "IiRyb290IiAteGRldiAtdHlwZSBmIC1w",
  "cmludDApCn0KCndyaXRlX2NvbnRyb2xf",
  "cm93KCkgewogIGxvY2FsIGxvZ2ljYWw9",
  "JDEKICBsb2NhbCBwYXRoPSQyCiAgbG9j",
  "YWwga2V5ZWQ9JDMKICBbWyAtZiAiJHBh",
  "dGgiICYmICEgLUwgIiRwYXRoIiBdXQog",
  "IFtbICQoL3Vzci9iaW4vc3RhdCAtYyAn",
  "JWEnIC0tICIkcGF0aCIpID09IDQ0NCBd",
  "XQogIFtbICQoL3Vzci9iaW4vc3RhdCAt",
  "YyAnJWgnIC0tICIkcGF0aCIpID09IDEg",
  "XV0KICBsb2NhbCBzaXplIGRpZ2VzdAog",
  "IHNpemU9JCgvdXNyL2Jpbi9zdGF0IC1j",
  "ICclcycgLS0gIiRwYXRoIikKICBkaWdl",
  "c3Q9JCgvdXNyL2Jpbi9zaGEyNTZzdW0g",
  "LS0gIiRwYXRoIikKICBkaWdlc3Q9JHtk",
  "aWdlc3QlJSAqfQogIHByaW50ZiAnQ1x0",
  "JXNcdENcdDA0NDRcdCVzXHQlc1x0JXNc",
  "bicgIiRsb2dpY2FsIiAiJHNpemUiICIk",
  "ZGlnZXN0IiAiJGxvZ2ljYWwiID4+IiRr",
  "ZXllZCIKfQoKZnVsbF9sZWRnZXIoKSB7",
  "CiAgbG9jYWwgb3V0cHV0PSQxCiAgbG9j",
  "YWwga2V5ZWQ9JHtvdXRwdXR9LmtleWVk",
  "CiAgbG9jYWwgcm93cz0ke291dHB1dH0u",
  "cm93cwogIGxvY2FsIGJvZHk9JHtvdXRw",
  "dXR9LmJvZHkKICA6ID4iJGtleWVkIgog",
  "IHdyaXRlX2RpcmVjdG9yeV9yb3dzIC9p",
  "bnB1dC9zb3VyY2Ugc291cmNlICIka2V5",
  "ZWQiCiAgd3JpdGVfZGlyZWN0b3J5X3Jv",
  "d3MgL2lucHV0L3ZlbmRvciB2ZW5kb3Ig",
  "IiRrZXllZCIKICB3cml0ZV9kaXJlY3Rv",
  "cnlfcm93cyAvaW5wdXQvdG9vbGNoYWlu",
  "IHRvb2xjaGFpbiAiJGtleWVkIgogIHdy",
  "aXRlX2ZpbGVfcm93cyBTIC9pbnB1dC9z",
  "b3VyY2UgIiRrZXllZCIKICB3cml0ZV9m",
  "aWxlX3Jvd3MgViAvaW5wdXQvdmVuZG9y",
  "ICIka2V5ZWQiCiAgd3JpdGVfZmlsZV9y",
  "b3dzIFQgL2lucHV0L3Rvb2xjaGFpbiAi",
  "JGtleWVkIgogIHdyaXRlX2NvbnRyb2xf",
  "cm93IGNvbnRyb2wvcHJvb2Yuc2ggL2lu",
  "cHV0L2NvbnRyb2wuc2ggIiRrZXllZCIK",
  "ICB3cml0ZV9jb250cm9sX3JvdyBldGMv",
  "aG9zdG5hbWUgL2V0Yy9ob3N0bmFtZSAi",
  "JGtleWVkIgogIHdyaXRlX2NvbnRyb2xf",
  "cm93IGV0Yy9ob3N0cyAvZXRjL2hvc3Rz",
  "ICIka2V5ZWQiCiAgd3JpdGVfY29udHJv",
  "bF9yb3cgZXRjL3Jlc29sdi5jb25mIC9l",
  "dGMvcmVzb2x2LmNvbmYgIiRrZXllZCIK",
  "ICBbWyAkKC91c3IvYmluL3djIC1sIDwi",
  "JGtleWVkIikgPT0gNDg1MyBdXQogIExB",
  "Tkc9QyAvdXNyL2Jpbi9zb3J0IC1vICIk",
  "a2V5ZWQiICIka2V5ZWQiCiAgL3Vzci9i",
  "aW4vY3V0IC1mMy0gIiRrZXllZCIgPiIk",
  "cm93cyIKICB7CiAgICBwcmludGYgJ29w",
  "ZW5zcGVsbC53cDIwMS52ZW5kb3ItbGVk",
  "Z2VyLnYxXG5yZWNvcmRzXHQ0ODUzXG4n",
  "CiAgICAvdXNyL2Jpbi9jYXQgIiRyb3dz",
  "IgogIH0gPiIkYm9keSIKICBsb2NhbCBk",
  "aWdlc3QKICBkaWdlc3Q9JCgvdXNyL2Jp",
  "bi9zaGEyNTZzdW0gLS0gIiRib2R5IikK",
  "ICBkaWdlc3Q9JHtkaWdlc3QlJSAqfQog",
  "IHsKICAgIC91c3IvYmluL2NhdCAiJGJv",
  "ZHkiCiAgICBwcmludGYgJ2VuZFx0JXNc",
  "bicgIiRkaWdlc3QiCiAgfSA+IiRvdXRw",
  "dXQiCiAgL3Vzci9iaW4vcm0gLS0gIiRr",
  "ZXllZCIgIiRyb3dzIiAiJGJvZHkiCn0K",
  "CnRvb2xjaGFpbl9hdXRob3JpdHkoKSB7",
  "CiAgbG9jYWwgb3V0cHV0PSQxCiAgbG9j",
  "YWwga2V5ZWQ9JHtvdXRwdXR9LmtleWVk",
  "CiAgbG9jYWwgcm93cz0ke291dHB1dH0u",
  "cm93cwogIGxvY2FsIGJvZHk9JHtvdXRw",
  "dXR9LmJvZHkKICA6ID4iJGtleWVkIgog",
  "IHdyaXRlX2RpcmVjdG9yeV9yb3dzIC9p",
  "bnB1dC90b29sY2hhaW4gdG9vbGNoYWlu",
  "ICIka2V5ZWQiCiAgd3JpdGVfZmlsZV9y",
  "b3dzIFQgL2lucHV0L3Rvb2xjaGFpbiAi",
  "JGtleWVkIgogIFtbICQoL3Vzci9iaW4v",
  "d2MgLWwgPCIka2V5ZWQiKSA9PSAxOTYg",
  "XV0KICBMQU5HPUMgL3Vzci9iaW4vc29y",
  "dCAtbyAiJGtleWVkIiAiJGtleWVkIgog",
  "IC91c3IvYmluL2N1dCAtZjMtICIka2V5",
  "ZWQiID4iJHJvd3MiCiAgewogICAgcHJp",
  "bnRmICdvcGVuc3BlbGwud3AyMDEudG9v",
  "bGNoYWluLWF1dGhvcml0eS52MVxucmVj",
  "b3Jkc1x0MTk2XG4nCiAgICAvdXNyL2Jp",
  "bi9jYXQgIiRyb3dzIgogIH0gPiIkYm9k",
  "eSIKICBsb2NhbCBkaWdlc3QKICBkaWdl",
  "c3Q9JCgvdXNyL2Jpbi9zaGEyNTZzdW0g",
  "LS0gIiRib2R5IikKICBkaWdlc3Q9JHtk",
  "aWdlc3QlJSAqfQogIHsKICAgIC91c3Iv",
  "YmluL2NhdCAiJGJvZHkiCiAgICBwcmlu",
  "dGYgJ2VuZFx0JXNcbicgIiRkaWdlc3Qi",
  "CiAgfSA+IiRvdXRwdXQiCiAgL3Vzci9i",
  "aW4vcm0gLS0gIiRrZXllZCIgIiRyb3dz",
  "IiAiJGJvZHkiCn0KCnZlcmlmeV9pbnB1",
  "dHMoKSB7CiAgbG9jYWwgc3VmZml4PSQx",
  "CiAgbG9jYWwgZnVsbD0vZml4dHVyZXMv",
  "ZnVsbC0kc3VmZml4LmxlZGdlcgogIGxv",
  "Y2FsIGF1dGhvcml0eT0vZml4dHVyZXMv",
  "dG9vbGNoYWluLSRzdWZmaXgubGVkZ2Vy",
  "CiAgW1sgJCgvdXNyL2Jpbi9zdGF0IC1j",
  "ICclYTolaCcgLS0gL2lucHV0L3ZlbmRv",
  "ci1sZWRnZXIudjEpID09IDQ0NDoxIF1d",
  "CiAgZnVsbF9sZWRnZXIgIiRmdWxsIgog",
  "IC91c3IvYmluL2NtcCAtLXNpbGVudCAv",
  "aW5wdXQvdmVuZG9yLWxlZGdlci52MSAi",
  "JGZ1bGwiCiAgdG9vbGNoYWluX2F1dGhv",
  "cml0eSAiJGF1dGhvcml0eSIKICBbWyAk",
  "KC91c3IvYmluL3N0YXQgLWMgJyVzJyAt",
  "LSAiJGF1dGhvcml0eSIpID09IDMwNTUz",
  "IF1dCiAgbG9jYWwgZGlnZXN0CiAgZGln",
  "ZXN0PSQoL3Vzci9iaW4vc2hhMjU2c3Vt",
  "IC0tICIkYXV0aG9yaXR5IikKICBbWyAk",
  "e2RpZ2VzdCUlICp9ID09IDYwNzhmNDll",
  "NzExYzNhNzA1OWUxMWE4YTdiMzdmNWY0",
  "OTgzN2M3OTI1MjNiZDkxNGUwNTkyYjQy",
  "ZDhmMDg3YTQgXV0KfQoKdmVyaWZ5X21v",
  "dW50cygpIHsKICBsb2NhbCB0YWJsZT0v",
  "Zml4dHVyZXMvbW91bnQtdGFibGUKICBs",
  "b2NhbCBhY3R1YWw9L2ZpeHR1cmVzL3dy",
  "aXRhYmxlLW1vdW50cwogIGxvY2FsIGV4",
  "cGVjdGVkPS9maXh0dXJlcy9leHBlY3Rl",
  "ZC13cml0YWJsZS1tb3VudHMKICAvdXNy",
  "L2Jpbi9hd2sgJwogICAgewogICAgICBz",
  "ZXBhcmF0b3IgPSAwCiAgICAgIGZvciAo",
  "ZmllbGQgPSA3OyBmaWVsZCA8PSBORjsg",
  "ZmllbGQgKz0gMSkgewogICAgICAgIGlm",
  "ICgkZmllbGQgPT0gIi0iKSB7IHNlcGFy",
  "YXRvciA9IGZpZWxkOyBicmVhayB9CiAg",
  "ICAgIH0KICAgICAgaWYgKHNlcGFyYXRv",
  "ciA9PSAwKSBleGl0IDEKICAgICAgcHJp",
  "bnRmICIlc1x0JXNcdCVzXHQlc1x0JXNc",
  "biIsICQ1LCAkNCwgJChzZXBhcmF0b3Ig",
  "KyAxKSwgJDYsICQoc2VwYXJhdG9yICsg",
  "MykKICAgIH0KICAnIC9wcm9jL3NlbGYv",
  "bW91bnRpbmZvID4iJHRhYmxlIgogIFtb",
  "IC16ICQoL3Vzci9iaW4vY3V0IC1mMSAi",
  "JHRhYmxlIiB8IExBTkc9QyAvdXNyL2Jp",
  "bi9zb3J0IHwgL3Vzci9iaW4vdW5pcSAt",
  "ZCkgXV0KICAvdXNyL2Jpbi9hd2sgLUYg",
  "J1x0JyAnaW5kZXgoIiwiICQ0ICIsIiwg",
  "IixydywiKSB7IHByaW50ICQxIH0nICIk",
  "dGFibGUiIHwgTEFORz1DIC91c3IvYmlu",
  "L3NvcnQgPiIkYWN0dWFsIgogIHByaW50",
  "ZiAnJXNcbicgXAogICAgL2NhcmdvIC9k",
  "ZXYgL2Rldi9tcXVldWUgL2Rldi9wdHMg",
  "L2Rldi9zaG0gL2ZpeHR1cmVzIFwKICAg",
  "IC9wcm9jIC9wcm9jL2ludGVycnVwdHMg",
  "L3Byb2Mva2NvcmUgL3Byb2Mva2V5cyAv",
  "cHJvYy9sYXRlbmN5X3N0YXRzIC9wcm9j",
  "L3RpbWVyX2xpc3QgXAogICAgL3Rhcmdl",
  "dCAvdG1wIC93cDIwMS1ob21lIHwgTEFO",
  "Rz1DIC91c3IvYmluL3NvcnQgPiIkZXhw",
  "ZWN0ZWQiCiAgL3Vzci9iaW4vY21wIC0t",
  "c2lsZW50ICIkZXhwZWN0ZWQiICIkYWN0",
  "dWFsIgoKICByZXF1aXJlX21vdW50KCkg",
  "ewogICAgbG9jYWwgcGF0aD0kMQogICAg",
  "bG9jYWwgcm9vdD0kMgogICAgbG9jYWwg",
  "ZmlsZXN5c3RlbT0kMwogICAgbG9jYWwg",
  "b3B0aW9ucz0kNAogICAgbG9jYWwgc3Vw",
  "ZXJfb3B0aW9ucz0kNQogICAgbG9jYWwg",
  "cm93CiAgICByb3c9JCgvdXNyL2Jpbi9h",
  "d2sgLUYgJ1x0JyAtdiBwYXRoPSIkcGF0",
  "aCIgJyQxID09IHBhdGggeyBwcmludCB9",
  "JyAiJHRhYmxlIikKICAgIFtbIC1uICIk",
  "cm93IiAmJiAkKHByaW50ZiAnJXNcbicg",
  "IiRyb3ciIHwgL3Vzci9iaW4vd2MgLWwp",
  "ID09IDEgXV0KICAgIGxvY2FsIGFjdHVh",
  "bF9wYXRoIGFjdHVhbF9yb290IGFjdHVh",
  "bF9maWxlc3lzdGVtIGFjdHVhbF9vcHRp",
  "b25zIGFjdHVhbF9zdXBlcgogICAgSUZT",
  "PSQnXHQnIHJlYWQgLXIgYWN0dWFsX3Bh",
  "dGggYWN0dWFsX3Jvb3QgYWN0dWFsX2Zp",
  "bGVzeXN0ZW0gYWN0dWFsX29wdGlvbnMg",
  "YWN0dWFsX3N1cGVyIDw8PCIkcm93Igog",
  "ICAgW1sgIiRhY3R1YWxfcGF0aCIgPT0g",
  "IiRwYXRoIiAmJiAiJGFjdHVhbF9yb290",
  "IiA9PSAiJHJvb3QiIF1dCiAgICBbWyAi",
  "JGFjdHVhbF9maWxlc3lzdGVtIiA9PSAi",
  "JGZpbGVzeXN0ZW0iICYmICIkYWN0dWFs",
  "X29wdGlvbnMiID09ICIkb3B0aW9ucyIg",
  "XV0KICAgIFtbICIkc3VwZXJfb3B0aW9u",
  "cyIgPT0gJyonIHx8ICIkYWN0dWFsX3N1",
  "cGVyIiA9PSAiJHN1cGVyX29wdGlvbnMi",
  "IF1dCiAgfQoKICByZXF1aXJlX3JlYWRf",
  "b25seV9tb3VudCgpIHsKICAgIGxvY2Fs",
  "IHBhdGg9JDEKICAgIGxvY2FsIHJvdwog",
  "ICAgcm93PSQoL3Vzci9iaW4vYXdrIC1G",
  "ICdcdCcgLXYgcGF0aD0iJHBhdGgiICck",
  "MSA9PSBwYXRoIHsgcHJpbnQgfScgIiR0",
  "YWJsZSIpCiAgICBbWyAtbiAiJHJvdyIg",
  "JiYgJChwcmludGYgJyVzXG4nICIkcm93",
  "IiB8IC91c3IvYmluL3djIC1sKSA9PSAx",
  "IF1dCiAgICBsb2NhbCBpZ25vcmVkIGFj",
  "dHVhbF9vcHRpb25zCiAgICBJRlM9JCdc",
  "dCcgcmVhZCAtciBpZ25vcmVkIGlnbm9y",
  "ZWQgaWdub3JlZCBhY3R1YWxfb3B0aW9u",
  "cyBpZ25vcmVkIDw8PCIkcm93IgogICAg",
  "W1sgIiwkYWN0dWFsX29wdGlvbnMsIiA9",
  "PSAqLHJvLCogXV0KICB9CgogIHJlcXVp",
  "cmVfbW91bnQgLyAvIG92ZXJsYXkgcm8s",
  "cmVsYXRpbWUgJyonCiAgcmVxdWlyZV9t",
  "b3VudCAvc3lzIC8gc3lzZnMgcm8sbm9z",
  "dWlkLG5vZGV2LG5vZXhlYyxyZWxhdGlt",
  "ZSAnKicKICByZXF1aXJlX21vdW50IC9z",
  "eXMvZnMvY2dyb3VwIC8gY2dyb3VwMiBy",
  "byxub3N1aWQsbm9kZXYsbm9leGVjLHJl",
  "bGF0aW1lICcqJwogIHJlcXVpcmVfbW91",
  "bnQgL2NhcmdvIC8gdG1wZnMgcncsbm9z",
  "dWlkLG5vZGV2LG5vZXhlYyxyZWxhdGlt",
  "ZSBydyxzaXplPTI2MjE0NGssbW9kZT03",
  "MDAsaW5vZGU2NAogIHJlcXVpcmVfbW91",
  "bnQgL3RhcmdldCAvIHRtcGZzIHJ3LG5v",
  "c3VpZCxub2RldixyZWxhdGltZSBydyxz",
  "aXplPTQxOTQzMDRrLG1vZGU9NzAwLGlu",
  "b2RlNjQKICByZXF1aXJlX21vdW50IC90",
  "bXAgLyB0bXBmcyBydyxub3N1aWQsbm9k",
  "ZXYsbm9leGVjLHJlbGF0aW1lIHJ3LHNp",
  "emU9MTA0ODU3NmssbW9kZT03MDAsaW5v",
  "ZGU2NAogIHJlcXVpcmVfbW91bnQgL2Zp",
  "eHR1cmVzIC8gdG1wZnMgcncsbm9zdWlk",
  "LG5vZGV2LG5vZXhlYyxyZWxhdGltZSBy",
  "dyxzaXplPTIwOTcxNTJrLG1vZGU9NzAw",
  "LGlub2RlNjQKICByZXF1aXJlX21vdW50",
  "IC93cDIwMS1ob21lIC8gdG1wZnMgcncs",
  "bm9zdWlkLG5vZGV2LG5vZXhlYyxyZWxh",
  "dGltZSBydyxzaXplPTE2Mzg0ayxtb2Rl",
  "PTcwMCxpbm9kZTY0CiAgcmVxdWlyZV9t",
  "b3VudCAvZGV2L3NobSAvIHRtcGZzIHJ3",
  "LG5vc3VpZCxub2Rldixub2V4ZWMscmVs",
  "YXRpbWUgcncsc2l6ZT0yMDk3MTUyayxp",
  "bm9kZTY0CiAgW1sgJCgvdXNyL2Jpbi9z",
  "dGF0IC1jICclYToldTolZycgL2Nhcmdv",
  "IC90YXJnZXQgL3RtcCAvZml4dHVyZXMg",
  "L3dwMjAxLWhvbWUpID09ICQnNzAwOjA6",
  "MFxuNzAwOjA6MFxuNzAwOjA6MFxuNzAw",
  "OjA6MFxuNzAwOjA6MCcgXV0KICBbWyAk",
  "KC91c3IvYmluL3N0YXQgLWMgJyVhOiV1",
  "OiVnJyAvZGV2L3NobSkgPT0gMTc3Nzow",
  "OjAgXV0KCiAgbG9jYWwgYWN0dWFsX3By",
  "b2M9L2ZpeHR1cmVzL3Byb2MtbW91bnRz",
  "CiAgbG9jYWwgZXhwZWN0ZWRfcHJvYz0v",
  "Zml4dHVyZXMvZXhwZWN0ZWQtcHJvYy1t",
  "b3VudHMKICAvdXNyL2Jpbi9hd2sgLUYg",
  "J1x0JyAnJDEgPT0gIi9wcm9jIiB8fCBp",
  "bmRleCgkMSwgIi9wcm9jLyIpID09IDEg",
  "eyBwcmludCAkMSB9JyAiJHRhYmxlIiB8",
  "IExBTkc9QyAvdXNyL2Jpbi9zb3J0ID4i",
  "JGFjdHVhbF9wcm9jIgogIHByaW50ZiAn",
  "JXNcbicgL3Byb2MgL3Byb2MvYWNwaSAv",
  "cHJvYy9hc291bmQgL3Byb2MvYnVzIC9w",
  "cm9jL2ZzIC9wcm9jL2ludGVycnVwdHMg",
  "XAogICAgL3Byb2MvaXJxIC9wcm9jL2tj",
  "b3JlIC9wcm9jL2tleXMgL3Byb2MvbGF0",
  "ZW5jeV9zdGF0cyAvcHJvYy9zY3NpIC9w",
  "cm9jL3N5cyBcCiAgICAvcHJvYy9zeXNy",
  "cS10cmlnZ2VyIC9wcm9jL3RpbWVyX2xp",
  "c3QgfCBMQU5HPUMgL3Vzci9iaW4vc29y",
  "dCA+IiRleHBlY3RlZF9wcm9jIgogIC91",
  "c3IvYmluL2NtcCAtLXNpbGVudCAiJGV4",
  "cGVjdGVkX3Byb2MiICIkYWN0dWFsX3By",
  "b2MiCiAgcmVxdWlyZV9tb3VudCAvcHJv",
  "YyAvIHByb2Mgcncsbm9zdWlkLG5vZGV2",
  "LG5vZXhlYyxyZWxhdGltZSBydwogIHJl",
  "cXVpcmVfbW91bnQgL3Byb2MvYnVzIC9i",
  "dXMgcHJvYyBybyxub3N1aWQsbm9kZXYs",
  "bm9leGVjLHJlbGF0aW1lIHJ3CiAgcmVx",
  "dWlyZV9tb3VudCAvcHJvYy9mcyAvZnMg",
  "cHJvYyBybyxub3N1aWQsbm9kZXYsbm9l",
  "eGVjLHJlbGF0aW1lIHJ3CiAgcmVxdWly",
  "ZV9tb3VudCAvcHJvYy9pcnEgL2lycSBw",
  "cm9jIHJvLG5vc3VpZCxub2Rldixub2V4",
  "ZWMscmVsYXRpbWUgcncKICByZXF1aXJl",
  "X21vdW50IC9wcm9jL3N5cyAvc3lzIHBy",
  "b2Mgcm8sbm9zdWlkLG5vZGV2LG5vZXhl",
  "YyxyZWxhdGltZSBydwogIHJlcXVpcmVf",
  "bW91bnQgL3Byb2Mvc3lzcnEtdHJpZ2dl",
  "ciAvc3lzcnEtdHJpZ2dlciBwcm9jIHJv",
  "LG5vc3VpZCxub2Rldixub2V4ZWMscmVs",
  "YXRpbWUgcncKICByZXF1aXJlX21vdW50",
  "IC9wcm9jL2FjcGkgLyB0bXBmcyBybyxy",
  "ZWxhdGltZSBybyxzaXplPTRrLG5yX2lu",
  "b2Rlcz0xLGlub2RlNjQKICByZXF1aXJl",
  "X21vdW50IC9wcm9jL2Fzb3VuZCAvIHRt",
  "cGZzIHJvLHJlbGF0aW1lIHJvLHNpemU9",
  "NGssbnJfaW5vZGVzPTEsaW5vZGU2NAog",
  "IHJlcXVpcmVfbW91bnQgL3Byb2Mvc2Nz",
  "aSAvIHRtcGZzIHJvLHJlbGF0aW1lIHJv",
  "LHNpemU9NGssbnJfaW5vZGVzPTEsaW5v",
  "ZGU2NAogIGZvciBwYXRoIGluIC9wcm9j",
  "L2ludGVycnVwdHMgL3Byb2Mva2NvcmUg",
  "L3Byb2Mva2V5cyAvcHJvYy9sYXRlbmN5",
  "X3N0YXRzIC9wcm9jL3RpbWVyX2xpc3Q7",
  "IGRvCiAgICByZXF1aXJlX21vdW50ICIk",
  "cGF0aCIgL251bGwgdG1wZnMgcncsbm9z",
  "dWlkICcqJwogIGRvbmUKCiAgZm9yIHBh",
  "dGggaW4gL2lucHV0L3NvdXJjZSAvaW5w",
  "dXQvdmVuZG9yIC9pbnB1dC90b29sY2hh",
  "aW4gL2lucHV0L3ZlbmRvci1sZWRnZXIu",
  "djEgXAogICAgL2lucHV0L2NvbnRyb2wu",
  "c2ggL2V0Yy9ob3N0bmFtZSAvZXRjL2hv",
  "c3RzIC9ldGMvcmVzb2x2LmNvbmY7IGRv",
  "CiAgICByZXF1aXJlX3JlYWRfb25seV9t",
  "b3VudCAiJHBhdGgiCiAgZG9uZQogIFtb",
  "IC16ICQoL3Vzci9iaW4vYXdrICckNSB+",
  "ICJeL2lucHV0Lyhzb3VyY2V8dmVuZG9y",
  "fHRvb2xjaGFpbikvIiB7IHByaW50OyBl",
  "eGl0IH0nIC9wcm9jL3NlbGYvbW91bnRp",
  "bmZvKSBdXQp9CgpuYW1lc3BhY2VfaWQo",
  "KSB7CiAgbG9jYWwgbmFtZXNwYWNlPSQx",
  "CiAgbG9jYWwgdmFsdWUKICB2YWx1ZT0k",
  "KC91c3IvYmluL3JlYWRsaW5rICIvcHJv",
  "Yy9zZWxmL25zLyRuYW1lc3BhY2UiKQog",
  "IFtbICIkdmFsdWUiID1+IF4kbmFtZXNw",
  "YWNlOlxbWzAtOV0rXF0kIF1dCiAgcHJp",
  "bnRmICclcycgIiR2YWx1ZSIKfQoKdmVy",
  "aWZ5X25hbWVzcGFjZV9nYXRlKCkgewog",
  "IGxvY2FsIG5hbWVzcGFjZSBzZWxmX3Zh",
  "bHVlIGluaXRfdmFsdWUgaG9zdF92YWx1",
  "ZQogIGZvciBuYW1lc3BhY2UgaW4gY2dy",
  "b3VwIGlwYyBtbnQgbmV0IHBpZCB1c2Vy",
  "IHV0czsgZG8KICAgIHNlbGZfdmFsdWU9",
  "JChuYW1lc3BhY2VfaWQgIiRuYW1lc3Bh",
  "Y2UiKQogICAgaW5pdF92YWx1ZT0kKC91",
  "c3IvYmluL3JlYWRsaW5rICIvcHJvYy8x",
  "L25zLyRuYW1lc3BhY2UiKQogICAgW1sg",
  "IiRzZWxmX3ZhbHVlIiA9PSAiJGluaXRf",
  "dmFsdWUiIF1dCiAgICBwcmludGYgLXYg",
  "InByb29mX25hbWVzcGFjZV8kbmFtZXNw",
  "YWNlIiAnJXMnICIkc2VsZl92YWx1ZSIK",
  "ICBkb25lCiAgcHJpbnRmICdvcGVuc3Bl",
  "bGwud3AyMDEubmFtZXNwYWNlLXJlYWR5",
  "LnYxXG4nCiAgbG9jYWwgZnJhbWU9L2Zp",
  "eHR1cmVzL25hbWVzcGFjZS1mcmFtZQog",
  "IC91c3IvYmluL2hlYWQgLWMgNTEzID4i",
  "JGZyYW1lIgogIFtbICQoL3Vzci9iaW4v",
  "c3RhdCAtYyAnJWE6JXU6JWc6JWgnIC0t",
  "ICIkZnJhbWUiKSA9PSA2MDA6MDowOjEg",
  "XV0KICBbWyAkKC91c3IvYmluL3N0YXQg",
  "LWMgJyVzJyAtLSAiJGZyYW1lIikgLWxl",
  "IDUxMiBdXQogIGlmIC91c3IvYmluL29k",
  "IC1BbiAtdiAtdHgxIC0tICIkZnJhbWUi",
  "IHwgL3Vzci9iaW4vZ3JlcCAtcSAnIDAw",
  "JzsgdGhlbgogICAgZmFsc2UKICBmaQog",
  "IFtbICQoL3Vzci9iaW4vdGFpbCAtYyAx",
  "IC0tICIkZnJhbWUiIHwgL3Vzci9iaW4v",
  "b2QgLUFuIC12IC10dTEgfCAvdXNyL2Jp",
  "bi90ciAtZCAnIFxuJykgPT0gMTAgXV0K",
  "ICBbWyAkKC91c3IvYmluL3djIC1sIDwi",
  "JGZyYW1lIikgPT0gOCBdXQogIGxvY2Fs",
  "IC1hIGxpbmVzCiAgbWFwZmlsZSAtdCBs",
  "aW5lcyA8IiRmcmFtZSIKICBbWyAkeyNs",
  "aW5lc1tAXX0gLWVxIDggXV0KICBbWyAi",
  "JHtsaW5lc1swXX0iID09IG9wZW5zcGVs",
  "bC53cDIwMS5uYW1lc3BhY2UtZ2F0ZS52",
  "MSBdXQogIGxvY2FsIGluZGV4PTEKICBm",
  "b3IgbmFtZXNwYWNlIGluIGNncm91cCBp",
  "cGMgbW50IG5ldCBwaWQgdXNlciB1dHM7",
  "IGRvCiAgICBob3N0X3ZhbHVlPSR7bGlu",
  "ZXNbJGluZGV4XX0KICAgIFtbICIkaG9z",
  "dF92YWx1ZSIgPX4gXiRuYW1lc3BhY2U6",
  "XFtbMC05XXsxLDIwfVxdJCBdXQogICAg",
  "c2VsZl92YWx1ZT0kKG5hbWVzcGFjZV9p",
  "ZCAiJG5hbWVzcGFjZSIpCiAgICBpZiBb",
  "WyAiJG5hbWVzcGFjZSIgPT0gdXNlciBd",
  "XTsgdGhlbgogICAgICBbWyAiJHNlbGZf",
  "dmFsdWUiID09ICIkaG9zdF92YWx1ZSIg",
  "XV0KICAgIGVsc2UKICAgICAgW1sgIiRz",
  "ZWxmX3ZhbHVlIiAhPSAiJGhvc3RfdmFs",
  "dWUiIF1dCiAgICBmaQogICAgKChpbmRl",
  "eCArPSAxKSkKICBkb25lCiAgL3Vzci9i",
  "aW4vcm0gLS0gIiRmcmFtZSIKfQoKdmVy",
  "aWZ5X25hbWVzcGFjZXNfc3RhYmxlKCkg",
  "ewogIGxvY2FsIG5hbWVzcGFjZSBleHBl",
  "Y3RlZCBleHBlY3RlZF92YXJpYWJsZQog",
  "IGZvciBuYW1lc3BhY2UgaW4gY2dyb3Vw",
  "IGlwYyBtbnQgbmV0IHBpZCB1c2VyIHV0",
  "czsgZG8KICAgIGV4cGVjdGVkX3Zhcmlh",
  "YmxlPXByb29mX25hbWVzcGFjZV8kbmFt",
  "ZXNwYWNlCiAgICBleHBlY3RlZD0keyFl",
  "eHBlY3RlZF92YXJpYWJsZX0KICAgIFtb",
  "ICQobmFtZXNwYWNlX2lkICIkbmFtZXNw",
  "YWNlIikgPT0gIiRleHBlY3RlZCIgXV0K",
  "ICBkb25lCn0KCnZlcmlmeV9sb2NrKCkg",
  "ewogIGxvY2FsIHBhdGg9JDEKICBsb2Nh",
  "bCBwYWNrYWdlcz0kMgogIGxvY2FsIHJl",
  "Z2lzdHJpZXM9JDMKICBsb2NhbCBjaGVj",
  "a3N1bXM9JDQKICBzaGlmdCA0CiAgW1sg",
  "JCgvdXNyL2Jpbi9ncmVwIC1jICdeXFtc",
  "W3BhY2thZ2VcXVxdJCcgIiRwYXRoIikg",
  "PT0gIiRwYWNrYWdlcyIgXV0KICBbWyAk",
  "KC91c3IvYmluL2dyZXAgLWMgJ15zb3Vy",
  "Y2UgPSAicmVnaXN0cnkraHR0cHM6Ly9n",
  "aXRodWIuY29tL3J1c3QtbGFuZy9jcmF0",
  "ZXMuaW8taW5kZXgiJCcgIiRwYXRoIikg",
  "PT0gIiRyZWdpc3RyaWVzIiBdXQogIFtb",
  "IC16ICQoL3Vzci9iaW4vZ3JlcCAnXnNv",
  "dXJjZSA9ICcgIiRwYXRoIiB8IC91c3Iv",
  "YmluL2dyZXAgLXYgJ15zb3VyY2UgPSAi",
  "cmVnaXN0cnkraHR0cHM6Ly9naXRodWIu",
  "Y29tL3J1c3QtbGFuZy9jcmF0ZXMuaW8t",
  "aW5kZXgiJCcpIF1dCiAgW1sgJCgvdXNy",
  "L2Jpbi9ncmVwIC1jICdeY2hlY2tzdW0g",
  "PSAiWzAtOWEtZl1cezY0XH0iJCcgIiRw",
  "YXRoIikgPT0gIiRjaGVja3N1bXMiIF1d",
  "CiAgW1sgJCgocGFja2FnZXMgLSByZWdp",
  "c3RyaWVzKSkgPT0gJCMgXV0KICBsb2Nh",
  "bCBwYWNrYWdlCiAgZm9yIHBhY2thZ2Ug",
  "aW4gIiRAIjsgZG8KICAgIFtbICQoL3Vz",
  "ci9iaW4vZ3JlcCAtYyAiXm5hbWUgPSBc",
  "IiRwYWNrYWdlXCIkIiAiJHBhdGgiKSA9",
  "PSAxIF1dCiAgZG9uZQp9Cgp2ZXJpZnlf",
  "bG9ja3MoKSB7CiAgdmVyaWZ5X2xvY2sg",
  "L2lucHV0L3NvdXJjZS90b29scy9ob3N0",
  "ZWQtbWlncmF0aW9uLXByZXBhcmF0aW9u",
  "LXByb29mL0NhcmdvLmxvY2sgNjggNjUg",
  "NjUgXAogICAgb3BlbnNwZWxsLWhvc3Rl",
  "ZC1taWdyYXRpb24tcHJlcGFyYXRpb24t",
  "cHJvb2YgXAogICAgb3BlbnNwZWxsLWhv",
  "c3RlZC1taWdyYXRpb24tcm9vdC1hdXRo",
  "b3JpdHkgXAogICAgb3BlbnNwZWxsLWhv",
  "c3RlZC1taWdyYXRpb24tcnVudGltZS1w",
  "cm9vZgogIHZlcmlmeV9sb2NrIC9pbnB1",
  "dC9zb3VyY2UvdG9vbHMvaG9zdGVkLW1p",
  "Z3JhdGlvbi1yb290LWF1dGhvcml0eS9D",
  "YXJnby5sb2NrIDYxIDYwIDYwIFwKICAg",
  "IG9wZW5zcGVsbC1ob3N0ZWQtbWlncmF0",
  "aW9uLXJvb3QtYXV0aG9yaXR5CiAgdmVy",
  "aWZ5X2xvY2sgL2lucHV0L3NvdXJjZS90",
  "b29scy9ob3N0ZWQtbWlncmF0aW9uLXJ1",
  "bnRpbWUtcHJvb2YvQ2FyZ28ubG9jayA2",
  "OSA2OCA2OCBcCiAgICBvcGVuc3BlbGwt",
  "aG9zdGVkLW1pZ3JhdGlvbi1ydW50aW1l",
  "LXByb29mCn0KCltbIC16ICQoL3Vzci9i",
  "aW4vZmluZCAvY2FyZ28gL3RhcmdldCAv",
  "dG1wIC9maXh0dXJlcyAvd3AyMDEtaG9t",
  "ZSAtbWluZGVwdGggMSAtcHJpbnQgLXF1",
  "aXQpIF1dCnZlcmlmeV9tb3VudHMKdmVy",
  "aWZ5X25hbWVzcGFjZV9nYXRlCnZlcmlm",
  "eV9pbnB1dHMgYmVmb3JlCnZlcmlmeV9s",
  "b2NrcwptYXJrZXJfYT1vcGVuc3BlbGwu",
  "d3AyMDEuCm1hcmtlcl9iPXJvb3QtYnJp",
  "ZGdlLXN1Y2Nlc3MudjEKaWYgL3Vzci9i",
  "aW4vZ3JlcCAtYSAtUiAtRiAtbCAtLSAi",
  "JG1hcmtlcl9hJG1hcmtlcl9iIiAvaW5w",
  "dXQvY29udHJvbC5zaCAvaW5wdXQvdmVu",
  "ZG9yIC9pbnB1dC90b29sY2hhaW4gPi9k",
  "ZXYvbnVsbDsgdGhlbgogIGV4aXQgMQpm",
  "aQovYmluL21rZGlyIC90YXJnZXQvY3Vy",
  "cmVudAoKc2V0ICtlCmNhc2UgIiRyb3df",
  "aWQiIGluCiAgcm9vdC1mbXQpCiAgICAv",
  "dXNyL2Jpbi9lbnYgLWkgUEFUSD0vdXNy",
  "L2xvY2FsL2NhcmdvL2JpbjovdXNyL2Jp",
  "bjovYmluIEhPTUU9L3dwMjAxLWhvbWUg",
  "Q0FSR09fSE9NRT0vY2FyZ28gQ0FSR09f",
  "VEFSR0VUX0RJUj0vdGFyZ2V0L2N1cnJl",
  "bnQgVE1QRElSPS9maXh0dXJlcyBSVVNU",
  "VVBfSE9NRT0vaW5wdXQvdG9vbGNoYWlu",
  "IFJVU1RVUF9UT09MQ0hBSU49MS45Ny4x",
  "LXg4Nl82NC11bmtub3duLWxpbnV4LWdu",
  "dSBSVVNUVVBfTk9fVVBEQVRFX0NIRUNL",
  "PTEgQ0FSR09fTkVUX09GRkxJTkU9dHJ1",
  "ZSBDQVJHT19URVJNX0NPTE9SPW5ldmVy",
  "IExBTkc9QyBMQ19BTEw9QyAvdXNyL2xv",
  "Y2FsL2NhcmdvL2Jpbi9jYXJnbyBmbXQg",
  "LS1tYW5pZmVzdC1wYXRoIC9pbnB1dC9z",
  "b3VyY2UvdG9vbHMvaG9zdGVkLW1pZ3Jh",
  "dGlvbi1yb290LWF1dGhvcml0eS9DYXJn",
  "by50b21sIC0tYWxsIC0tIC0tY2hlY2sg",
  "OzsKICByb290LWNoZWNrLW5vbmUpCiAg",
  "ICAvdXNyL2Jpbi9lbnYgLWkgUEFUSD0v",
  "dXNyL2xvY2FsL2NhcmdvL2JpbjovdXNy",
  "L2JpbjovYmluIEhPTUU9L3dwMjAxLWhv",
  "bWUgQ0FSR09fSE9NRT0vY2FyZ28gQ0FS",
  "R09fVEFSR0VUX0RJUj0vdGFyZ2V0L2N1",
  "cnJlbnQgVE1QRElSPS9maXh0dXJlcyBS",
  "VVNUVVBfSE9NRT0vaW5wdXQvdG9vbGNo",
  "YWluIFJVU1RVUF9UT09MQ0hBSU49MS45",
  "Ny4xLXg4Nl82NC11bmtub3duLWxpbnV4",
  "LWdudSBSVVNUVVBfTk9fVVBEQVRFX0NI",
  "RUNLPTEgQ0FSR09fTkVUX09GRkxJTkU9",
  "dHJ1ZSBDQVJHT19URVJNX0NPTE9SPW5l",
  "dmVyIExBTkc9QyBMQ19BTEw9QyAvdXNy",
  "L2xvY2FsL2NhcmdvL2Jpbi9jYXJnbyBj",
  "aGVjayAtLWxvY2tlZCAtLW9mZmxpbmUg",
  "LS1jb25maWcgbmV0Lm9mZmxpbmU9dHJ1",
  "ZSAtLWNvbmZpZyAnc291cmNlLmNyYXRl",
  "cy1pby5yZXBsYWNlLXdpdGg9InZlbmRv",
  "cmVkLXNvdXJjZXMiJyAtLWNvbmZpZyAn",
  "c291cmNlLnZlbmRvcmVkLXNvdXJjZXMu",
  "ZGlyZWN0b3J5PSIvaW5wdXQvdmVuZG9y",
  "IicgLS1tYW5pZmVzdC1wYXRoIC9pbnB1",
  "dC9zb3VyY2UvdG9vbHMvaG9zdGVkLW1p",
  "Z3JhdGlvbi1yb290LWF1dGhvcml0eS9D",
  "YXJnby50b21sIC0tbm8tZGVmYXVsdC1m",
  "ZWF0dXJlcyAtLWFsbC10YXJnZXRzIDs7",
  "CiAgcm9vdC1jbGlwcHktbm9uZSkKICAg",
  "IC91c3IvYmluL2VudiAtaSBQQVRIPS91",
  "c3IvbG9jYWwvY2FyZ28vYmluOi91c3Iv",
  "YmluOi9iaW4gSE9NRT0vd3AyMDEtaG9t",
  "ZSBDQVJHT19IT01FPS9jYXJnbyBDQVJH",
  "T19UQVJHRVRfRElSPS90YXJnZXQvY3Vy",
  "cmVudCBUTVBESVI9L2ZpeHR1cmVzIFJV",
  "U1RVUF9IT01FPS9pbnB1dC90b29sY2hh",
  "aW4gUlVTVFVQX1RPT0xDSEFJTj0xLjk3",
  "LjEteDg2XzY0LXVua25vd24tbGludXgt",
  "Z251IFJVU1RVUF9OT19VUERBVEVfQ0hF",
  "Q0s9MSBDQVJHT19ORVRfT0ZGTElORT10",
  "cnVlIENBUkdPX1RFUk1fQ09MT1I9bmV2",
  "ZXIgTEFORz1DIExDX0FMTD1DIC91c3Iv",
  "bG9jYWwvY2FyZ28vYmluL2NhcmdvIGNs",
  "aXBweSAtLWxvY2tlZCAtLW9mZmxpbmUg",
  "LS1jb25maWcgbmV0Lm9mZmxpbmU9dHJ1",
  "ZSAtLWNvbmZpZyAnc291cmNlLmNyYXRl",
  "cy1pby5yZXBsYWNlLXdpdGg9InZlbmRv",
  "cmVkLXNvdXJjZXMiJyAtLWNvbmZpZyAn",
  "c291cmNlLnZlbmRvcmVkLXNvdXJjZXMu",
  "ZGlyZWN0b3J5PSIvaW5wdXQvdmVuZG9y",
  "IicgLS1tYW5pZmVzdC1wYXRoIC9pbnB1",
  "dC9zb3VyY2UvdG9vbHMvaG9zdGVkLW1p",
  "Z3JhdGlvbi1yb290LWF1dGhvcml0eS9D",
  "YXJnby50b21sIC0tbm8tZGVmYXVsdC1m",
  "ZWF0dXJlcyAtLWFsbC10YXJnZXRzIC0t",
  "IC1EIHdhcm5pbmdzIDs7CiAgcm9vdC1y",
  "dXN0ZG9jLW5vbmUpCiAgICAvdXNyL2Jp",
  "bi9lbnYgLWkgUEFUSD0vdXNyL2xvY2Fs",
  "L2NhcmdvL2JpbjovdXNyL2JpbjovYmlu",
  "IEhPTUU9L3dwMjAxLWhvbWUgQ0FSR09f",
  "SE9NRT0vY2FyZ28gQ0FSR09fVEFSR0VU",
  "X0RJUj0vdGFyZ2V0L2N1cnJlbnQgVE1Q",
  "RElSPS9maXh0dXJlcyBSVVNUVVBfSE9N",
  "RT0vaW5wdXQvdG9vbGNoYWluIFJVU1RV",
  "UF9UT09MQ0hBSU49MS45Ny4xLXg4Nl82",
  "NC11bmtub3duLWxpbnV4LWdudSBSVVNU",
  "VVBfTk9fVVBEQVRFX0NIRUNLPTEgQ0FS",
  "R09fTkVUX09GRkxJTkU9dHJ1ZSBDQVJH",
  "T19URVJNX0NPTE9SPW5ldmVyIExBTkc9",
  "QyBMQ19BTEw9QyAvdXNyL2xvY2FsL2Nh",
  "cmdvL2Jpbi9jYXJnbyBydXN0ZG9jIC0t",
  "bG9ja2VkIC0tb2ZmbGluZSAtLWNvbmZp",
  "ZyBuZXQub2ZmbGluZT10cnVlIC0tY29u",
  "ZmlnICdzb3VyY2UuY3JhdGVzLWlvLnJl",
  "cGxhY2Utd2l0aD0idmVuZG9yZWQtc291",
  "cmNlcyInIC0tY29uZmlnICdzb3VyY2Uu",
  "dmVuZG9yZWQtc291cmNlcy5kaXJlY3Rv",
  "cnk9Ii9pbnB1dC92ZW5kb3IiJyAtLW1h",
  "bmlmZXN0LXBhdGggL2lucHV0L3NvdXJj",
  "ZS90b29scy9ob3N0ZWQtbWlncmF0aW9u",
  "LXJvb3QtYXV0aG9yaXR5L0NhcmdvLnRv",
  "bWwgLS1uby1kZWZhdWx0LWZlYXR1cmVz",
  "IC0tbGliIC0tIC1EIHdhcm5pbmdzIDs7",
  "CiAgcm9vdC10ZXN0LW5vbmUpCiAgICAv",
  "dXNyL2Jpbi9lbnYgLWkgUEFUSD0vdXNy",
  "L2xvY2FsL2NhcmdvL2JpbjovdXNyL2Jp",
  "bjovYmluIEhPTUU9L3dwMjAxLWhvbWUg",
  "Q0FSR09fSE9NRT0vY2FyZ28gQ0FSR09f",
  "VEFSR0VUX0RJUj0vdGFyZ2V0L2N1cnJl",
  "bnQgVE1QRElSPS9maXh0dXJlcyBSVVNU",
  "VVBfSE9NRT0vaW5wdXQvdG9vbGNoYWlu",
  "IFJVU1RVUF9UT09MQ0hBSU49MS45Ny4x",
  "LXg4Nl82NC11bmtub3duLWxpbnV4LWdu",
  "dSBSVVNUVVBfTk9fVVBEQVRFX0NIRUNL",
  "PTEgQ0FSR09fTkVUX09GRkxJTkU9dHJ1",
  "ZSBDQVJHT19URVJNX0NPTE9SPW5ldmVy",
  "IExBTkc9QyBMQ19BTEw9QyAvdXNyL2xv",
  "Y2FsL2NhcmdvL2Jpbi9jYXJnbyB0ZXN0",
  "IC0tbG9ja2VkIC0tb2ZmbGluZSAtLWNv",
  "bmZpZyBuZXQub2ZmbGluZT10cnVlIC0t",
  "Y29uZmlnICdzb3VyY2UuY3JhdGVzLWlv",
  "LnJlcGxhY2Utd2l0aD0idmVuZG9yZWQt",
  "c291cmNlcyInIC0tY29uZmlnICdzb3Vy",
  "Y2UudmVuZG9yZWQtc291cmNlcy5kaXJl",
  "Y3Rvcnk9Ii9pbnB1dC92ZW5kb3IiJyAt",
  "LW1hbmlmZXN0LXBhdGggL2lucHV0L3Nv",
  "dXJjZS90b29scy9ob3N0ZWQtbWlncmF0",
  "aW9uLXJvb3QtYXV0aG9yaXR5L0Nhcmdv",
  "LnRvbWwgLS1uby1kZWZhdWx0LWZlYXR1",
  "cmVzIC0tYWxsLXRhcmdldHMgOzsKICBy",
  "b290LWNoZWNrLWludGVybmFsKQogICAg",
  "L3Vzci9iaW4vZW52IC1pIFBBVEg9L3Vz",
  "ci9sb2NhbC9jYXJnby9iaW46L3Vzci9i",
  "aW46L2JpbiBIT01FPS93cDIwMS1ob21l",
  "IENBUkdPX0hPTUU9L2NhcmdvIENBUkdP",
  "X1RBUkdFVF9ESVI9L3RhcmdldC9jdXJy",
  "ZW50IFRNUERJUj0vZml4dHVyZXMgUlVT",
  "VFVQX0hPTUU9L2lucHV0L3Rvb2xjaGFp",
  "biBSVVNUVVBfVE9PTENIQUlOPTEuOTcu",
  "MS14ODZfNjQtdW5rbm93bi1saW51eC1n",
  "bnUgUlVTVFVQX05PX1VQREFURV9DSEVD",
  "Sz0xIENBUkdPX05FVF9PRkZMSU5FPXRy",
  "dWUgQ0FSR09fVEVSTV9DT0xPUj1uZXZl",
  "ciBMQU5HPUMgTENfQUxMPUMgL3Vzci9s",
  "b2NhbC9jYXJnby9iaW4vY2FyZ28gY2hl",
  "Y2sgLS1sb2NrZWQgLS1vZmZsaW5lIC0t",
  "Y29uZmlnIG5ldC5vZmZsaW5lPXRydWUg",
  "LS1jb25maWcgJ3NvdXJjZS5jcmF0ZXMt",
  "aW8ucmVwbGFjZS13aXRoPSJ2ZW5kb3Jl",
  "ZC1zb3VyY2VzIicgLS1jb25maWcgJ3Nv",
  "dXJjZS52ZW5kb3JlZC1zb3VyY2VzLmRp",
  "cmVjdG9yeT0iL2lucHV0L3ZlbmRvciIn",
  "IC0tbWFuaWZlc3QtcGF0aCAvaW5wdXQv",
  "c291cmNlL3Rvb2xzL2hvc3RlZC1taWdy",
  "YXRpb24tcm9vdC1hdXRob3JpdHkvQ2Fy",
  "Z28udG9tbCAtLW5vLWRlZmF1bHQtZmVh",
  "dHVyZXMgLS1mZWF0dXJlcyB3cDIwMS1p",
  "bnRlcm5hbCAtLWFsbC10YXJnZXRzIDs7",
  "CiAgcm9vdC1jbGlwcHktaW50ZXJuYWwp",
  "CiAgICAvdXNyL2Jpbi9lbnYgLWkgUEFU",
  "SD0vdXNyL2xvY2FsL2NhcmdvL2Jpbjov",
  "dXNyL2JpbjovYmluIEhPTUU9L3dwMjAx",
  "LWhvbWUgQ0FSR09fSE9NRT0vY2FyZ28g",
  "Q0FSR09fVEFSR0VUX0RJUj0vdGFyZ2V0",
  "L2N1cnJlbnQgVE1QRElSPS9maXh0dXJl",
  "cyBSVVNUVVBfSE9NRT0vaW5wdXQvdG9v",
  "bGNoYWluIFJVU1RVUF9UT09MQ0hBSU49",
  "MS45Ny4xLXg4Nl82NC11bmtub3duLWxp",
  "bnV4LWdudSBSVVNUVVBfTk9fVVBEQVRF",
  "X0NIRUNLPTEgQ0FSR09fTkVUX09GRkxJ",
  "TkU9dHJ1ZSBDQVJHT19URVJNX0NPTE9S",
  "PW5ldmVyIExBTkc9QyBMQ19BTEw9QyAv",
  "dXNyL2xvY2FsL2NhcmdvL2Jpbi9jYXJn",
  "byBjbGlwcHkgLS1sb2NrZWQgLS1vZmZs",
  "aW5lIC0tY29uZmlnIG5ldC5vZmZsaW5l",
  "PXRydWUgLS1jb25maWcgJ3NvdXJjZS5j",
  "cmF0ZXMtaW8ucmVwbGFjZS13aXRoPSJ2",
  "ZW5kb3JlZC1zb3VyY2VzIicgLS1jb25m",
  "aWcgJ3NvdXJjZS52ZW5kb3JlZC1zb3Vy",
  "Y2VzLmRpcmVjdG9yeT0iL2lucHV0L3Zl",
  "bmRvciInIC0tbWFuaWZlc3QtcGF0aCAv",
  "aW5wdXQvc291cmNlL3Rvb2xzL2hvc3Rl",
  "ZC1taWdyYXRpb24tcm9vdC1hdXRob3Jp",
  "dHkvQ2FyZ28udG9tbCAtLW5vLWRlZmF1",
  "bHQtZmVhdHVyZXMgLS1mZWF0dXJlcyB3",
  "cDIwMS1pbnRlcm5hbCAtLWFsbC10YXJn",
  "ZXRzIC0tIC1EIHdhcm5pbmdzIDs7CiAg",
  "cm9vdC1ydXN0ZG9jLWludGVybmFsKQog",
  "ICAgL3Vzci9iaW4vZW52IC1pIFBBVEg9",
  "L3Vzci9sb2NhbC9jYXJnby9iaW46L3Vz",
  "ci9iaW46L2JpbiBIT01FPS93cDIwMS1o",
  "b21lIENBUkdPX0hPTUU9L2NhcmdvIENB",
  "UkdPX1RBUkdFVF9ESVI9L3RhcmdldC9j",
  "dXJyZW50IFRNUERJUj0vZml4dHVyZXMg",
  "UlVTVFVQX0hPTUU9L2lucHV0L3Rvb2xj",
  "aGFpbiBSVVNUVVBfVE9PTENIQUlOPTEu",
  "OTcuMS14ODZfNjQtdW5rbm93bi1saW51",
  "eC1nbnUgUlVTVFVQX05PX1VQREFURV9D",
  "SEVDSz0xIENBUkdPX05FVF9PRkZMSU5F",
  "PXRydWUgQ0FSR09fVEVSTV9DT0xPUj1u",
  "ZXZlciBMQU5HPUMgTENfQUxMPUMgL3Vz",
  "ci9sb2NhbC9jYXJnby9iaW4vY2FyZ28g",
  "cnVzdGRvYyAtLWxvY2tlZCAtLW9mZmxp",
  "bmUgLS1jb25maWcgbmV0Lm9mZmxpbmU9",
  "dHJ1ZSAtLWNvbmZpZyAnc291cmNlLmNy",
  "YXRlcy1pby5yZXBsYWNlLXdpdGg9InZl",
  "bmRvcmVkLXNvdXJjZXMiJyAtLWNvbmZp",
  "ZyAnc291cmNlLnZlbmRvcmVkLXNvdXJj",
  "ZXMuZGlyZWN0b3J5PSIvaW5wdXQvdmVu",
  "ZG9yIicgLS1tYW5pZmVzdC1wYXRoIC9p",
  "bnB1dC9zb3VyY2UvdG9vbHMvaG9zdGVk",
  "LW1pZ3JhdGlvbi1yb290LWF1dGhvcml0",
  "eS9DYXJnby50b21sIC0tbm8tZGVmYXVs",
  "dC1mZWF0dXJlcyAtLWZlYXR1cmVzIHdw",
  "MjAxLWludGVybmFsIC0tbGliIC0tIC1E",
  "IHdhcm5pbmdzIDs7CiAgcm9vdC10ZXN0",
  "LWludGVybmFsKQogICAgL3Vzci9iaW4v",
  "ZW52IC1pIFBBVEg9L3Vzci9sb2NhbC9j",
  "YXJnby9iaW46L3Vzci9iaW46L2JpbiBI",
  "T01FPS93cDIwMS1ob21lIENBUkdPX0hP",
  "TUU9L2NhcmdvIENBUkdPX1RBUkdFVF9E",
  "SVI9L3RhcmdldC9jdXJyZW50IFRNUERJ",
  "Uj0vZml4dHVyZXMgUlVTVFVQX0hPTUU9",
  "L2lucHV0L3Rvb2xjaGFpbiBSVVNUVVBf",
  "VE9PTENIQUlOPTEuOTcuMS14ODZfNjQt",
  "dW5rbm93bi1saW51eC1nbnUgUlVTVFVQ",
  "X05PX1VQREFURV9DSEVDSz0xIENBUkdP",
  "X05FVF9PRkZMSU5FPXRydWUgQ0FSR09f",
  "VEVSTV9DT0xPUj1uZXZlciBMQU5HPUMg",
  "TENfQUxMPUMgL3Vzci9sb2NhbC9jYXJn",
  "by9iaW4vY2FyZ28gdGVzdCAtLWxvY2tl",
  "ZCAtLW9mZmxpbmUgLS1jb25maWcgbmV0",
  "Lm9mZmxpbmU9dHJ1ZSAtLWNvbmZpZyAn",
  "c291cmNlLmNyYXRlcy1pby5yZXBsYWNl",
  "LXdpdGg9InZlbmRvcmVkLXNvdXJjZXMi",
  "JyAtLWNvbmZpZyAnc291cmNlLnZlbmRv",
  "cmVkLXNvdXJjZXMuZGlyZWN0b3J5PSIv",
  "aW5wdXQvdmVuZG9yIicgLS1tYW5pZmVz",
  "dC1wYXRoIC9pbnB1dC9zb3VyY2UvdG9v",
  "bHMvaG9zdGVkLW1pZ3JhdGlvbi1yb290",
  "LWF1dGhvcml0eS9DYXJnby50b21sIC0t",
  "bm8tZGVmYXVsdC1mZWF0dXJlcyAtLWZl",
  "YXR1cmVzIHdwMjAxLWludGVybmFsIC0t",
  "YWxsLXRhcmdldHMgOzsKICBydW50aW1l",
  "LWZtdCkKICAgIC91c3IvYmluL2VudiAt",
  "aSBQQVRIPS91c3IvbG9jYWwvY2FyZ28v",
  "YmluOi91c3IvYmluOi9iaW4gSE9NRT0v",
  "d3AyMDEtaG9tZSBDQVJHT19IT01FPS9j",
  "YXJnbyBDQVJHT19UQVJHRVRfRElSPS90",
  "YXJnZXQvY3VycmVudCBUTVBESVI9L2Zp",
  "eHR1cmVzIFJVU1RVUF9IT01FPS9pbnB1",
  "dC90b29sY2hhaW4gUlVTVFVQX1RPT0xD",
  "SEFJTj0xLjk3LjEteDg2XzY0LXVua25v",
  "d24tbGludXgtZ251IFJVU1RVUF9OT19V",
  "UERBVEVfQ0hFQ0s9MSBDQVJHT19ORVRf",
  "T0ZGTElORT10cnVlIENBUkdPX1RFUk1f",
  "Q09MT1I9bmV2ZXIgTEFORz1DIExDX0FM",
  "TD1DIC91c3IvbG9jYWwvY2FyZ28vYmlu",
  "L2NhcmdvIGZtdCAtLW1hbmlmZXN0LXBh",
  "dGggL2lucHV0L3NvdXJjZS90b29scy9o",
  "b3N0ZWQtbWlncmF0aW9uLXJ1bnRpbWUt",
  "cHJvb2YvQ2FyZ28udG9tbCAtLWFsbCAt",
  "LSAtLWNoZWNrIDs7CiAgcnVudGltZS1j",
  "aGVjay1ub25lKQogICAgL3Vzci9iaW4v",
  "ZW52IC1pIFBBVEg9L3Vzci9sb2NhbC9j",
  "YXJnby9iaW46L3Vzci9iaW46L2JpbiBI",
  "T01FPS93cDIwMS1ob21lIENBUkdPX0hP",
  "TUU9L2NhcmdvIENBUkdPX1RBUkdFVF9E",
  "SVI9L3RhcmdldC9jdXJyZW50IFRNUERJ",
  "Uj0vZml4dHVyZXMgUlVTVFVQX0hPTUU9",
  "L2lucHV0L3Rvb2xjaGFpbiBSVVNUVVBf",
  "VE9PTENIQUlOPTEuOTcuMS14ODZfNjQt",
  "dW5rbm93bi1saW51eC1nbnUgUlVTVFVQ",
  "X05PX1VQREFURV9DSEVDSz0xIENBUkdP",
  "X05FVF9PRkZMSU5FPXRydWUgQ0FSR09f",
  "VEVSTV9DT0xPUj1uZXZlciBMQU5HPUMg",
  "TENfQUxMPUMgL3Vzci9sb2NhbC9jYXJn",
  "by9iaW4vY2FyZ28gY2hlY2sgLS1sb2Nr",
  "ZWQgLS1vZmZsaW5lIC0tY29uZmlnIG5l",
  "dC5vZmZsaW5lPXRydWUgLS1jb25maWcg",
  "J3NvdXJjZS5jcmF0ZXMtaW8ucmVwbGFj",
  "ZS13aXRoPSJ2ZW5kb3JlZC1zb3VyY2Vz",
  "IicgLS1jb25maWcgJ3NvdXJjZS52ZW5k",
  "b3JlZC1zb3VyY2VzLmRpcmVjdG9yeT0i",
  "L2lucHV0L3ZlbmRvciInIC0tbWFuaWZl",
  "c3QtcGF0aCAvaW5wdXQvc291cmNlL3Rv",
  "b2xzL2hvc3RlZC1taWdyYXRpb24tcnVu",
  "dGltZS1wcm9vZi9DYXJnby50b21sIC0t",
  "bm8tZGVmYXVsdC1mZWF0dXJlcyAtLWFs",
  "bC10YXJnZXRzIDs7CiAgcnVudGltZS1j",
  "bGlwcHktbm9uZSkKICAgIC91c3IvYmlu",
  "L2VudiAtaSBQQVRIPS91c3IvbG9jYWwv",
  "Y2FyZ28vYmluOi91c3IvYmluOi9iaW4g",
  "SE9NRT0vd3AyMDEtaG9tZSBDQVJHT19I",
  "T01FPS9jYXJnbyBDQVJHT19UQVJHRVRf",
  "RElSPS90YXJnZXQvY3VycmVudCBUTVBE",
  "SVI9L2ZpeHR1cmVzIFJVU1RVUF9IT01F",
  "PS9pbnB1dC90b29sY2hhaW4gUlVTVFVQ",
  "X1RPT0xDSEFJTj0xLjk3LjEteDg2XzY0",
  "LXVua25vd24tbGludXgtZ251IFJVU1RV",
  "UF9OT19VUERBVEVfQ0hFQ0s9MSBDQVJH",
  "T19ORVRfT0ZGTElORT10cnVlIENBUkdP",
  "X1RFUk1fQ09MT1I9bmV2ZXIgTEFORz1D",
  "IExDX0FMTD1DIC91c3IvbG9jYWwvY2Fy",
  "Z28vYmluL2NhcmdvIGNsaXBweSAtLWxv",
  "Y2tlZCAtLW9mZmxpbmUgLS1jb25maWcg",
  "bmV0Lm9mZmxpbmU9dHJ1ZSAtLWNvbmZp",
  "ZyAnc291cmNlLmNyYXRlcy1pby5yZXBs",
  "YWNlLXdpdGg9InZlbmRvcmVkLXNvdXJj",
  "ZXMiJyAtLWNvbmZpZyAnc291cmNlLnZl",
  "bmRvcmVkLXNvdXJjZXMuZGlyZWN0b3J5",
  "PSIvaW5wdXQvdmVuZG9yIicgLS1tYW5p",
  "ZmVzdC1wYXRoIC9pbnB1dC9zb3VyY2Uv",
  "dG9vbHMvaG9zdGVkLW1pZ3JhdGlvbi1y",
  "dW50aW1lLXByb29mL0NhcmdvLnRvbWwg",
  "LS1uby1kZWZhdWx0LWZlYXR1cmVzIC0t",
  "YWxsLXRhcmdldHMgLS0gLUQgd2Fybmlu",
  "Z3MgOzsKICBydW50aW1lLXJ1c3Rkb2Mt",
  "bm9uZSkKICAgIC91c3IvYmluL2VudiAt",
  "aSBQQVRIPS91c3IvbG9jYWwvY2FyZ28v",
  "YmluOi91c3IvYmluOi9iaW4gSE9NRT0v",
  "d3AyMDEtaG9tZSBDQVJHT19IT01FPS9j",
  "YXJnbyBDQVJHT19UQVJHRVRfRElSPS90",
  "YXJnZXQvY3VycmVudCBUTVBESVI9L2Zp",
  "eHR1cmVzIFJVU1RVUF9IT01FPS9pbnB1",
  "dC90b29sY2hhaW4gUlVTVFVQX1RPT0xD",
  "SEFJTj0xLjk3LjEteDg2XzY0LXVua25v",
  "d24tbGludXgtZ251IFJVU1RVUF9OT19V",
  "UERBVEVfQ0hFQ0s9MSBDQVJHT19ORVRf",
  "T0ZGTElORT10cnVlIENBUkdPX1RFUk1f",
  "Q09MT1I9bmV2ZXIgTEFORz1DIExDX0FM",
  "TD1DIC91c3IvbG9jYWwvY2FyZ28vYmlu",
  "L2NhcmdvIHJ1c3Rkb2MgLS1sb2NrZWQg",
  "LS1vZmZsaW5lIC0tY29uZmlnIG5ldC5v",
  "ZmZsaW5lPXRydWUgLS1jb25maWcgJ3Nv",
  "dXJjZS5jcmF0ZXMtaW8ucmVwbGFjZS13",
  "aXRoPSJ2ZW5kb3JlZC1zb3VyY2VzIicg",
  "LS1jb25maWcgJ3NvdXJjZS52ZW5kb3Jl",
  "ZC1zb3VyY2VzLmRpcmVjdG9yeT0iL2lu",
  "cHV0L3ZlbmRvciInIC0tbWFuaWZlc3Qt",
  "cGF0aCAvaW5wdXQvc291cmNlL3Rvb2xz",
  "L2hvc3RlZC1taWdyYXRpb24tcnVudGlt",
  "ZS1wcm9vZi9DYXJnby50b21sIC0tbm8t",
  "ZGVmYXVsdC1mZWF0dXJlcyAtLWxpYiAt",
  "LSAtRCB3YXJuaW5ncyA7OwogIHJ1bnRp",
  "bWUtdGVzdC1ub25lKQogICAgL3Vzci9i",
  "aW4vZW52IC1pIFBBVEg9L3Vzci9sb2Nh",
  "bC9jYXJnby9iaW46L3Vzci9iaW46L2Jp",
  "biBIT01FPS93cDIwMS1ob21lIENBUkdP",
  "X0hPTUU9L2NhcmdvIENBUkdPX1RBUkdF",
  "VF9ESVI9L3RhcmdldC9jdXJyZW50IFRN",
  "UERJUj0vZml4dHVyZXMgUlVTVFVQX0hP",
  "TUU9L2lucHV0L3Rvb2xjaGFpbiBSVVNU",
  "VVBfVE9PTENIQUlOPTEuOTcuMS14ODZf",
  "NjQtdW5rbm93bi1saW51eC1nbnUgUlVT",
  "VFVQX05PX1VQREFURV9DSEVDSz0xIENB",
  "UkdPX05FVF9PRkZMSU5FPXRydWUgQ0FS",
  "R09fVEVSTV9DT0xPUj1uZXZlciBMQU5H",
  "PUMgTENfQUxMPUMgL3Vzci9sb2NhbC9j",
  "YXJnby9iaW4vY2FyZ28gdGVzdCAtLWxv",
  "Y2tlZCAtLW9mZmxpbmUgLS1jb25maWcg",
  "bmV0Lm9mZmxpbmU9dHJ1ZSAtLWNvbmZp",
  "ZyAnc291cmNlLmNyYXRlcy1pby5yZXBs",
  "YWNlLXdpdGg9InZlbmRvcmVkLXNvdXJj",
  "ZXMiJyAtLWNvbmZpZyAnc291cmNlLnZl",
  "bmRvcmVkLXNvdXJjZXMuZGlyZWN0b3J5",
  "PSIvaW5wdXQvdmVuZG9yIicgLS1tYW5p",
  "ZmVzdC1wYXRoIC9pbnB1dC9zb3VyY2Uv",
  "dG9vbHMvaG9zdGVkLW1pZ3JhdGlvbi1y",
  "dW50aW1lLXByb29mL0NhcmdvLnRvbWwg",
  "LS1uby1kZWZhdWx0LWZlYXR1cmVzIC0t",
  "bGliIDs7CiAgcnVudGltZS1jaGVjay1p",
  "bnRlcm5hbCkKICAgIC91c3IvYmluL2Vu",
  "diAtaSBQQVRIPS91c3IvbG9jYWwvY2Fy",
  "Z28vYmluOi91c3IvYmluOi9iaW4gSE9N",
  "RT0vd3AyMDEtaG9tZSBDQVJHT19IT01F",
  "PS9jYXJnbyBDQVJHT19UQVJHRVRfRElS",
  "PS90YXJnZXQvY3VycmVudCBUTVBESVI9",
  "L2ZpeHR1cmVzIFJVU1RVUF9IT01FPS9p",
  "bnB1dC90b29sY2hhaW4gUlVTVFVQX1RP",
  "T0xDSEFJTj0xLjk3LjEteDg2XzY0LXVu",
  "a25vd24tbGludXgtZ251IFJVU1RVUF9O",
  "T19VUERBVEVfQ0hFQ0s9MSBDQVJHT19O",
  "RVRfT0ZGTElORT10cnVlIENBUkdPX1RF",
  "Uk1fQ09MT1I9bmV2ZXIgTEFORz1DIExD",
  "X0FMTD1DIC91c3IvbG9jYWwvY2FyZ28v",
  "YmluL2NhcmdvIGNoZWNrIC0tbG9ja2Vk",
  "IC0tb2ZmbGluZSAtLWNvbmZpZyBuZXQu",
  "b2ZmbGluZT10cnVlIC0tY29uZmlnICdz",
  "b3VyY2UuY3JhdGVzLWlvLnJlcGxhY2Ut",
  "d2l0aD0idmVuZG9yZWQtc291cmNlcyIn",
  "IC0tY29uZmlnICdzb3VyY2UudmVuZG9y",
  "ZWQtc291cmNlcy5kaXJlY3Rvcnk9Ii9p",
  "bnB1dC92ZW5kb3IiJyAtLW1hbmlmZXN0",
  "LXBhdGggL2lucHV0L3NvdXJjZS90b29s",
  "cy9ob3N0ZWQtbWlncmF0aW9uLXJ1bnRp",
  "bWUtcHJvb2YvQ2FyZ28udG9tbCAtLW5v",
  "LWRlZmF1bHQtZmVhdHVyZXMgLS1mZWF0",
  "dXJlcyB3cDIwMS1pbnRlcm5hbCAtLWFs",
  "bC10YXJnZXRzIDs7CiAgcnVudGltZS1j",
  "bGlwcHktaW50ZXJuYWwpCiAgICAvdXNy",
  "L2Jpbi9lbnYgLWkgUEFUSD0vdXNyL2xv",
  "Y2FsL2NhcmdvL2JpbjovdXNyL2Jpbjov",
  "YmluIEhPTUU9L3dwMjAxLWhvbWUgQ0FS",
  "R09fSE9NRT0vY2FyZ28gQ0FSR09fVEFS",
  "R0VUX0RJUj0vdGFyZ2V0L2N1cnJlbnQg",
  "VE1QRElSPS9maXh0dXJlcyBSVVNUVVBf",
  "SE9NRT0vaW5wdXQvdG9vbGNoYWluIFJV",
  "U1RVUF9UT09MQ0hBSU49MS45Ny4xLXg4",
  "Nl82NC11bmtub3duLWxpbnV4LWdudSBS",
  "VVNUVVBfTk9fVVBEQVRFX0NIRUNLPTEg",
  "Q0FSR09fTkVUX09GRkxJTkU9dHJ1ZSBD",
  "QVJHT19URVJNX0NPTE9SPW5ldmVyIExB",
  "Tkc9QyBMQ19BTEw9QyAvdXNyL2xvY2Fs",
  "L2NhcmdvL2Jpbi9jYXJnbyBjbGlwcHkg",
  "LS1sb2NrZWQgLS1vZmZsaW5lIC0tY29u",
  "ZmlnIG5ldC5vZmZsaW5lPXRydWUgLS1j",
  "b25maWcgJ3NvdXJjZS5jcmF0ZXMtaW8u",
  "cmVwbGFjZS13aXRoPSJ2ZW5kb3JlZC1z",
  "b3VyY2VzIicgLS1jb25maWcgJ3NvdXJj",
  "ZS52ZW5kb3JlZC1zb3VyY2VzLmRpcmVj",
  "dG9yeT0iL2lucHV0L3ZlbmRvciInIC0t",
  "bWFuaWZlc3QtcGF0aCAvaW5wdXQvc291",
  "cmNlL3Rvb2xzL2hvc3RlZC1taWdyYXRp",
  "b24tcnVudGltZS1wcm9vZi9DYXJnby50",
  "b21sIC0tbm8tZGVmYXVsdC1mZWF0dXJl",
  "cyAtLWZlYXR1cmVzIHdwMjAxLWludGVy",
  "bmFsIC0tYWxsLXRhcmdldHMgLS0gLUQg",
  "d2FybmluZ3MgOzsKICBydW50aW1lLXJ1",
  "c3Rkb2MtaW50ZXJuYWwpCiAgICAvdXNy",
  "L2Jpbi9lbnYgLWkgUEFUSD0vdXNyL2xv",
  "Y2FsL2NhcmdvL2JpbjovdXNyL2Jpbjov",
  "YmluIEhPTUU9L3dwMjAxLWhvbWUgQ0FS",
  "R09fSE9NRT0vY2FyZ28gQ0FSR09fVEFS",
  "R0VUX0RJUj0vdGFyZ2V0L2N1cnJlbnQg",
  "VE1QRElSPS9maXh0dXJlcyBSVVNUVVBf",
  "SE9NRT0vaW5wdXQvdG9vbGNoYWluIFJV",
  "U1RVUF9UT09MQ0hBSU49MS45Ny4xLXg4",
  "Nl82NC11bmtub3duLWxpbnV4LWdudSBS",
  "VVNUVVBfTk9fVVBEQVRFX0NIRUNLPTEg",
  "Q0FSR09fTkVUX09GRkxJTkU9dHJ1ZSBD",
  "QVJHT19URVJNX0NPTE9SPW5ldmVyIExB",
  "Tkc9QyBMQ19BTEw9QyAvdXNyL2xvY2Fs",
  "L2NhcmdvL2Jpbi9jYXJnbyBydXN0ZG9j",
  "IC0tbG9ja2VkIC0tb2ZmbGluZSAtLWNv",
  "bmZpZyBuZXQub2ZmbGluZT10cnVlIC0t",
  "Y29uZmlnICdzb3VyY2UuY3JhdGVzLWlv",
  "LnJlcGxhY2Utd2l0aD0idmVuZG9yZWQt",
  "c291cmNlcyInIC0tY29uZmlnICdzb3Vy",
  "Y2UudmVuZG9yZWQtc291cmNlcy5kaXJl",
  "Y3Rvcnk9Ii9pbnB1dC92ZW5kb3IiJyAt",
  "LW1hbmlmZXN0LXBhdGggL2lucHV0L3Nv",
  "dXJjZS90b29scy9ob3N0ZWQtbWlncmF0",
  "aW9uLXJ1bnRpbWUtcHJvb2YvQ2FyZ28u",
  "dG9tbCAtLW5vLWRlZmF1bHQtZmVhdHVy",
  "ZXMgLS1mZWF0dXJlcyB3cDIwMS1pbnRl",
  "cm5hbCAtLWxpYiAtLSAtRCB3YXJuaW5n",
  "cyA7OwogIHJ1bnRpbWUtdGVzdC1pbnRl",
  "cm5hbCkKICAgIC91c3IvYmluL2VudiAt",
  "aSBQQVRIPS91c3IvbG9jYWwvY2FyZ28v",
  "YmluOi91c3IvYmluOi9iaW4gSE9NRT0v",
  "d3AyMDEtaG9tZSBDQVJHT19IT01FPS9j",
  "YXJnbyBDQVJHT19UQVJHRVRfRElSPS90",
  "YXJnZXQvY3VycmVudCBUTVBESVI9L2Zp",
  "eHR1cmVzIFJVU1RVUF9IT01FPS9pbnB1",
  "dC90b29sY2hhaW4gUlVTVFVQX1RPT0xD",
  "SEFJTj0xLjk3LjEteDg2XzY0LXVua25v",
  "d24tbGludXgtZ251IFJVU1RVUF9OT19V",
  "UERBVEVfQ0hFQ0s9MSBDQVJHT19ORVRf",
  "T0ZGTElORT10cnVlIENBUkdPX1RFUk1f",
  "Q09MT1I9bmV2ZXIgTEFORz1DIExDX0FM",
  "TD1DIC91c3IvbG9jYWwvY2FyZ28vYmlu",
  "L2NhcmdvIHRlc3QgLS1sb2NrZWQgLS1v",
  "ZmZsaW5lIC0tY29uZmlnIG5ldC5vZmZs",
  "aW5lPXRydWUgLS1jb25maWcgJ3NvdXJj",
  "ZS5jcmF0ZXMtaW8ucmVwbGFjZS13aXRo",
  "PSJ2ZW5kb3JlZC1zb3VyY2VzIicgLS1j",
  "b25maWcgJ3NvdXJjZS52ZW5kb3JlZC1z",
  "b3VyY2VzLmRpcmVjdG9yeT0iL2lucHV0",
  "L3ZlbmRvciInIC0tbWFuaWZlc3QtcGF0",
  "aCAvaW5wdXQvc291cmNlL3Rvb2xzL2hv",
  "c3RlZC1taWdyYXRpb24tcnVudGltZS1w",
  "cm9vZi9DYXJnby50b21sIC0tbm8tZGVm",
  "YXVsdC1mZWF0dXJlcyAtLWZlYXR1cmVz",
  "IHdwMjAxLWludGVybmFsIC0tbGliIDs7",
  "CiAgcnVudGltZS1jaGVjay1hbGwpCiAg",
  "ICAvdXNyL2Jpbi9lbnYgLWkgUEFUSD0v",
  "dXNyL2xvY2FsL2NhcmdvL2JpbjovdXNy",
  "L2JpbjovYmluIEhPTUU9L3dwMjAxLWhv",
  "bWUgQ0FSR09fSE9NRT0vY2FyZ28gQ0FS",
  "R09fVEFSR0VUX0RJUj0vdGFyZ2V0L2N1",
  "cnJlbnQgVE1QRElSPS9maXh0dXJlcyBS",
  "VVNUVVBfSE9NRT0vaW5wdXQvdG9vbGNo",
  "YWluIFJVU1RVUF9UT09MQ0hBSU49MS45",
  "Ny4xLXg4Nl82NC11bmtub3duLWxpbnV4",
  "LWdudSBSVVNUVVBfTk9fVVBEQVRFX0NI",
  "RUNLPTEgQ0FSR09fTkVUX09GRkxJTkU9",
  "dHJ1ZSBDQVJHT19URVJNX0NPTE9SPW5l",
  "dmVyIExBTkc9QyBMQ19BTEw9QyAvdXNy",
  "L2xvY2FsL2NhcmdvL2Jpbi9jYXJnbyBj",
  "aGVjayAtLWxvY2tlZCAtLW9mZmxpbmUg",
  "LS1jb25maWcgbmV0Lm9mZmxpbmU9dHJ1",
  "ZSAtLWNvbmZpZyAnc291cmNlLmNyYXRl",
  "cy1pby5yZXBsYWNlLXdpdGg9InZlbmRv",
  "cmVkLXNvdXJjZXMiJyAtLWNvbmZpZyAn",
  "c291cmNlLnZlbmRvcmVkLXNvdXJjZXMu",
  "ZGlyZWN0b3J5PSIvaW5wdXQvdmVuZG9y",
  "IicgLS1tYW5pZmVzdC1wYXRoIC9pbnB1",
  "dC9zb3VyY2UvdG9vbHMvaG9zdGVkLW1p",
  "Z3JhdGlvbi1ydW50aW1lLXByb29mL0Nh",
  "cmdvLnRvbWwgLS1hbGwtZmVhdHVyZXMg",
  "LS1hbGwtdGFyZ2V0cyA7OwogIHJ1bnRp",
  "bWUtY2xpcHB5LWFsbCkKICAgIC91c3Iv",
  "YmluL2VudiAtaSBQQVRIPS91c3IvbG9j",
  "YWwvY2FyZ28vYmluOi91c3IvYmluOi9i",
  "aW4gSE9NRT0vd3AyMDEtaG9tZSBDQVJH",
  "T19IT01FPS9jYXJnbyBDQVJHT19UQVJH",
  "RVRfRElSPS90YXJnZXQvY3VycmVudCBU",
  "TVBESVI9L2ZpeHR1cmVzIFJVU1RVUF9I",
  "T01FPS9pbnB1dC90b29sY2hhaW4gUlVT",
  "VFVQX1RPT0xDSEFJTj0xLjk3LjEteDg2",
  "XzY0LXVua25vd24tbGludXgtZ251IFJV",
  "U1RVUF9OT19VUERBVEVfQ0hFQ0s9MSBD",
  "QVJHT19ORVRfT0ZGTElORT10cnVlIENB",
  "UkdPX1RFUk1fQ09MT1I9bmV2ZXIgTEFO",
  "Rz1DIExDX0FMTD1DIC91c3IvbG9jYWwv",
  "Y2FyZ28vYmluL2NhcmdvIGNsaXBweSAt",
  "LWxvY2tlZCAtLW9mZmxpbmUgLS1jb25m",
  "aWcgbmV0Lm9mZmxpbmU9dHJ1ZSAtLWNv",
  "bmZpZyAnc291cmNlLmNyYXRlcy1pby5y",
  "ZXBsYWNlLXdpdGg9InZlbmRvcmVkLXNv",
  "dXJjZXMiJyAtLWNvbmZpZyAnc291cmNl",
  "LnZlbmRvcmVkLXNvdXJjZXMuZGlyZWN0",
  "b3J5PSIvaW5wdXQvdmVuZG9yIicgLS1t",
  "YW5pZmVzdC1wYXRoIC9pbnB1dC9zb3Vy",
  "Y2UvdG9vbHMvaG9zdGVkLW1pZ3JhdGlv",
  "bi1ydW50aW1lLXByb29mL0NhcmdvLnRv",
  "bWwgLS1hbGwtZmVhdHVyZXMgLS1hbGwt",
  "dGFyZ2V0cyAtLSAtRCB3YXJuaW5ncyA7",
  "OwogIHJ1bnRpbWUtcnVzdGRvYy1hbGwp",
  "CiAgICAvdXNyL2Jpbi9lbnYgLWkgUEFU",
  "SD0vdXNyL2xvY2FsL2NhcmdvL2Jpbjov",
  "dXNyL2JpbjovYmluIEhPTUU9L3dwMjAx",
  "LWhvbWUgQ0FSR09fSE9NRT0vY2FyZ28g",
  "Q0FSR09fVEFSR0VUX0RJUj0vdGFyZ2V0",
  "L2N1cnJlbnQgVE1QRElSPS9maXh0dXJl",
  "cyBSVVNUVVBfSE9NRT0vaW5wdXQvdG9v",
  "bGNoYWluIFJVU1RVUF9UT09MQ0hBSU49",
  "MS45Ny4xLXg4Nl82NC11bmtub3duLWxp",
  "bnV4LWdudSBSVVNUVVBfTk9fVVBEQVRF",
  "X0NIRUNLPTEgQ0FSR09fTkVUX09GRkxJ",
  "TkU9dHJ1ZSBDQVJHT19URVJNX0NPTE9S",
  "PW5ldmVyIExBTkc9QyBMQ19BTEw9QyAv",
  "dXNyL2xvY2FsL2NhcmdvL2Jpbi9jYXJn",
  "byBydXN0ZG9jIC0tbG9ja2VkIC0tb2Zm",
  "bGluZSAtLWNvbmZpZyBuZXQub2ZmbGlu",
  "ZT10cnVlIC0tY29uZmlnICdzb3VyY2Uu",
  "Y3JhdGVzLWlvLnJlcGxhY2Utd2l0aD0i",
  "dmVuZG9yZWQtc291cmNlcyInIC0tY29u",
  "ZmlnICdzb3VyY2UudmVuZG9yZWQtc291",
  "cmNlcy5kaXJlY3Rvcnk9Ii9pbnB1dC92",
  "ZW5kb3IiJyAtLW1hbmlmZXN0LXBhdGgg",
  "L2lucHV0L3NvdXJjZS90b29scy9ob3N0",
  "ZWQtbWlncmF0aW9uLXJ1bnRpbWUtcHJv",
  "b2YvQ2FyZ28udG9tbCAtLWFsbC1mZWF0",
  "dXJlcyAtLWxpYiAtLSAtRCB3YXJuaW5n",
  "cyA7OwogIHJ1bnRpbWUtdGVzdC1hbGwp",
  "CiAgICAvdXNyL2Jpbi9lbnYgLWkgUEFU",
  "SD0vdXNyL2xvY2FsL2NhcmdvL2Jpbjov",
  "dXNyL2JpbjovYmluIEhPTUU9L3dwMjAx",
  "LWhvbWUgQ0FSR09fSE9NRT0vY2FyZ28g",
  "Q0FSR09fVEFSR0VUX0RJUj0vdGFyZ2V0",
  "L2N1cnJlbnQgVE1QRElSPS9maXh0dXJl",
  "cyBSVVNUVVBfSE9NRT0vaW5wdXQvdG9v",
  "bGNoYWluIFJVU1RVUF9UT09MQ0hBSU49",
  "MS45Ny4xLXg4Nl82NC11bmtub3duLWxp",
  "bnV4LWdudSBSVVNUVVBfTk9fVVBEQVRF",
  "X0NIRUNLPTEgQ0FSR09fTkVUX09GRkxJ",
  "TkU9dHJ1ZSBDQVJHT19URVJNX0NPTE9S",
  "PW5ldmVyIExBTkc9QyBMQ19BTEw9QyAv",
  "dXNyL2xvY2FsL2NhcmdvL2Jpbi9jYXJn",
  "byB0ZXN0IC0tbG9ja2VkIC0tb2ZmbGlu",
  "ZSAtLWNvbmZpZyBuZXQub2ZmbGluZT10",
  "cnVlIC0tY29uZmlnICdzb3VyY2UuY3Jh",
  "dGVzLWlvLnJlcGxhY2Utd2l0aD0idmVu",
  "ZG9yZWQtc291cmNlcyInIC0tY29uZmln",
  "ICdzb3VyY2UudmVuZG9yZWQtc291cmNl",
  "cy5kaXJlY3Rvcnk9Ii9pbnB1dC92ZW5k",
  "b3IiJyAtLW1hbmlmZXN0LXBhdGggL2lu",
  "cHV0L3NvdXJjZS90b29scy9ob3N0ZWQt",
  "bWlncmF0aW9uLXJ1bnRpbWUtcHJvb2Yv",
  "Q2FyZ28udG9tbCAtLWFsbC1mZWF0dXJl",
  "cyAtLWxpYiA7OwogIGNvb3JkaW5hdG9y",
  "LWZtdCkKICAgIC91c3IvYmluL2VudiAt",
  "aSBQQVRIPS91c3IvbG9jYWwvY2FyZ28v",
  "YmluOi91c3IvYmluOi9iaW4gSE9NRT0v",
  "d3AyMDEtaG9tZSBDQVJHT19IT01FPS9j",
  "YXJnbyBDQVJHT19UQVJHRVRfRElSPS90",
  "YXJnZXQvY3VycmVudCBUTVBESVI9L2Zp",
  "eHR1cmVzIFJVU1RVUF9IT01FPS9pbnB1",
  "dC90b29sY2hhaW4gUlVTVFVQX1RPT0xD",
  "SEFJTj0xLjk3LjEteDg2XzY0LXVua25v",
  "d24tbGludXgtZ251IFJVU1RVUF9OT19V",
  "UERBVEVfQ0hFQ0s9MSBDQVJHT19ORVRf",
  "T0ZGTElORT10cnVlIENBUkdPX1RFUk1f",
  "Q09MT1I9bmV2ZXIgTEFORz1DIExDX0FM",
  "TD1DIC91c3IvbG9jYWwvY2FyZ28vYmlu",
  "L2NhcmdvIGZtdCAtLW1hbmlmZXN0LXBh",
  "dGggL2lucHV0L3NvdXJjZS90b29scy9o",
  "b3N0ZWQtbWlncmF0aW9uLXByZXBhcmF0",
  "aW9uLXByb29mL0NhcmdvLnRvbWwgLS1h",
  "bGwgLS0gLS1jaGVjayA7OwogIGNvb3Jk",
  "aW5hdG9yLWNoZWNrKQogICAgL3Vzci9i",
  "aW4vZW52IC1pIFBBVEg9L3Vzci9sb2Nh",
  "bC9jYXJnby9iaW46L3Vzci9iaW46L2Jp",
  "biBIT01FPS93cDIwMS1ob21lIENBUkdP",
  "X0hPTUU9L2NhcmdvIENBUkdPX1RBUkdF",
  "VF9ESVI9L3RhcmdldC9jdXJyZW50IFRN",
  "UERJUj0vZml4dHVyZXMgUlVTVFVQX0hP",
  "TUU9L2lucHV0L3Rvb2xjaGFpbiBSVVNU",
  "VVBfVE9PTENIQUlOPTEuOTcuMS14ODZf",
  "NjQtdW5rbm93bi1saW51eC1nbnUgUlVT",
  "VFVQX05PX1VQREFURV9DSEVDSz0xIENB",
  "UkdPX05FVF9PRkZMSU5FPXRydWUgQ0FS",
  "R09fVEVSTV9DT0xPUj1uZXZlciBMQU5H",
  "PUMgTENfQUxMPUMgL3Vzci9sb2NhbC9j",
  "YXJnby9iaW4vY2FyZ28gY2hlY2sgLS1s",
  "b2NrZWQgLS1vZmZsaW5lIC0tY29uZmln",
  "IG5ldC5vZmZsaW5lPXRydWUgLS1jb25m",
  "aWcgJ3NvdXJjZS5jcmF0ZXMtaW8ucmVw",
  "bGFjZS13aXRoPSJ2ZW5kb3JlZC1zb3Vy",
  "Y2VzIicgLS1jb25maWcgJ3NvdXJjZS52",
  "ZW5kb3JlZC1zb3VyY2VzLmRpcmVjdG9y",
  "eT0iL2lucHV0L3ZlbmRvciInIC0tbWFu",
  "aWZlc3QtcGF0aCAvaW5wdXQvc291cmNl",
  "L3Rvb2xzL2hvc3RlZC1taWdyYXRpb24t",
  "cHJlcGFyYXRpb24tcHJvb2YvQ2FyZ28u",
  "dG9tbCAtLWFsbC10YXJnZXRzIDs7CiAg",
  "Y29vcmRpbmF0b3ItY2xpcHB5KQogICAg",
  "L3Vzci9iaW4vZW52IC1pIFBBVEg9L3Vz",
  "ci9sb2NhbC9jYXJnby9iaW46L3Vzci9i",
  "aW46L2JpbiBIT01FPS93cDIwMS1ob21l",
  "IENBUkdPX0hPTUU9L2NhcmdvIENBUkdP",
  "X1RBUkdFVF9ESVI9L3RhcmdldC9jdXJy",
  "ZW50IFRNUERJUj0vZml4dHVyZXMgUlVT",
  "VFVQX0hPTUU9L2lucHV0L3Rvb2xjaGFp",
  "biBSVVNUVVBfVE9PTENIQUlOPTEuOTcu",
  "MS14ODZfNjQtdW5rbm93bi1saW51eC1n",
  "bnUgUlVTVFVQX05PX1VQREFURV9DSEVD",
  "Sz0xIENBUkdPX05FVF9PRkZMSU5FPXRy",
  "dWUgQ0FSR09fVEVSTV9DT0xPUj1uZXZl",
  "ciBMQU5HPUMgTENfQUxMPUMgL3Vzci9s",
  "b2NhbC9jYXJnby9iaW4vY2FyZ28gY2xp",
  "cHB5IC0tbG9ja2VkIC0tb2ZmbGluZSAt",
  "LWNvbmZpZyBuZXQub2ZmbGluZT10cnVl",
  "IC0tY29uZmlnICdzb3VyY2UuY3JhdGVz",
  "LWlvLnJlcGxhY2Utd2l0aD0idmVuZG9y",
  "ZWQtc291cmNlcyInIC0tY29uZmlnICdz",
  "b3VyY2UudmVuZG9yZWQtc291cmNlcy5k",
  "aXJlY3Rvcnk9Ii9pbnB1dC92ZW5kb3Ii",
  "JyAtLW1hbmlmZXN0LXBhdGggL2lucHV0",
  "L3NvdXJjZS90b29scy9ob3N0ZWQtbWln",
  "cmF0aW9uLXByZXBhcmF0aW9uLXByb29m",
  "L0NhcmdvLnRvbWwgLS1hbGwtdGFyZ2V0",
  "cyAtLSAtRCB3YXJuaW5ncyA7OwogIGNv",
  "b3JkaW5hdG9yLXJ1c3Rkb2MpCiAgICAv",
  "dXNyL2Jpbi9lbnYgLWkgUEFUSD0vdXNy",
  "L2xvY2FsL2NhcmdvL2JpbjovdXNyL2Jp",
  "bjovYmluIEhPTUU9L3dwMjAxLWhvbWUg",
  "Q0FSR09fSE9NRT0vY2FyZ28gQ0FSR09f",
  "VEFSR0VUX0RJUj0vdGFyZ2V0L2N1cnJl",
  "bnQgVE1QRElSPS9maXh0dXJlcyBSVVNU",
  "VVBfSE9NRT0vaW5wdXQvdG9vbGNoYWlu",
  "IFJVU1RVUF9UT09MQ0hBSU49MS45Ny4x",
  "LXg4Nl82NC11bmtub3duLWxpbnV4LWdu",
  "dSBSVVNUVVBfTk9fVVBEQVRFX0NIRUNL",
  "PTEgQ0FSR09fTkVUX09GRkxJTkU9dHJ1",
  "ZSBDQVJHT19URVJNX0NPTE9SPW5ldmVy",
  "IExBTkc9QyBMQ19BTEw9QyAvdXNyL2xv",
  "Y2FsL2NhcmdvL2Jpbi9jYXJnbyBydXN0",
  "ZG9jIC0tbG9ja2VkIC0tb2ZmbGluZSAt",
  "LWNvbmZpZyBuZXQub2ZmbGluZT10cnVl",
  "IC0tY29uZmlnICdzb3VyY2UuY3JhdGVz",
  "LWlvLnJlcGxhY2Utd2l0aD0idmVuZG9y",
  "ZWQtc291cmNlcyInIC0tY29uZmlnICdz",
  "b3VyY2UudmVuZG9yZWQtc291cmNlcy5k",
  "aXJlY3Rvcnk9Ii9pbnB1dC92ZW5kb3Ii",
  "JyAtLW1hbmlmZXN0LXBhdGggL2lucHV0",
  "L3NvdXJjZS90b29scy9ob3N0ZWQtbWln",
  "cmF0aW9uLXByZXBhcmF0aW9uLXByb29m",
  "L0NhcmdvLnRvbWwgLS1saWIgLS0gLUQg",
  "d2FybmluZ3MgOzsKICBjb29yZGluYXRv",
  "ci10ZXN0KQogICAgL3Vzci9iaW4vZW52",
  "IC1pIFBBVEg9L3Vzci9sb2NhbC9jYXJn",
  "by9iaW46L3Vzci9iaW46L2JpbiBIT01F",
  "PS93cDIwMS1ob21lIENBUkdPX0hPTUU9",
  "L2NhcmdvIENBUkdPX1RBUkdFVF9ESVI9",
  "L3RhcmdldC9jdXJyZW50IFRNUERJUj0v",
  "Zml4dHVyZXMgUlVTVFVQX0hPTUU9L2lu",
  "cHV0L3Rvb2xjaGFpbiBSVVNUVVBfVE9P",
  "TENIQUlOPTEuOTcuMS14ODZfNjQtdW5r",
  "bm93bi1saW51eC1nbnUgUlVTVFVQX05P",
  "X1VQREFURV9DSEVDSz0xIENBUkdPX05F",
  "VF9PRkZMSU5FPXRydWUgQ0FSR09fVEVS",
  "TV9DT0xPUj1uZXZlciBMQU5HPUMgTENf",
  "QUxMPUMgL3Vzci9sb2NhbC9jYXJnby9i",
  "aW4vY2FyZ28gdGVzdCAtLWxvY2tlZCAt",
  "LW9mZmxpbmUgLS1jb25maWcgbmV0Lm9m",
  "ZmxpbmU9dHJ1ZSAtLWNvbmZpZyAnc291",
  "cmNlLmNyYXRlcy1pby5yZXBsYWNlLXdp",
  "dGg9InZlbmRvcmVkLXNvdXJjZXMiJyAt",
  "LWNvbmZpZyAnc291cmNlLnZlbmRvcmVk",
  "LXNvdXJjZXMuZGlyZWN0b3J5PSIvaW5w",
  "dXQvdmVuZG9yIicgLS1tYW5pZmVzdC1w",
  "YXRoIC9pbnB1dC9zb3VyY2UvdG9vbHMv",
  "aG9zdGVkLW1pZ3JhdGlvbi1wcmVwYXJh",
  "dGlvbi1wcm9vZi9DYXJnby50b21sIC0t",
  "YWxsLXRhcmdldHMgOzsKICByb290LXBv",
  "c2l0aXZlKQogICAgL3Vzci9iaW4vZW52",
  "IC1pIFBBVEg9L3Vzci9sb2NhbC9jYXJn",
  "by9iaW46L3Vzci9iaW46L2JpbiBIT01F",
  "PS93cDIwMS1ob21lIENBUkdPX0hPTUU9",
  "L2NhcmdvIENBUkdPX1RBUkdFVF9ESVI9",
  "L3RhcmdldC9jdXJyZW50IFRNUERJUj0v",
  "Zml4dHVyZXMgUlVTVFVQX0hPTUU9L2lu",
  "cHV0L3Rvb2xjaGFpbiBSVVNUVVBfVE9P",
  "TENIQUlOPTEuOTcuMS14ODZfNjQtdW5r",
  "bm93bi1saW51eC1nbnUgUlVTVFVQX05P",
  "X1VQREFURV9DSEVDSz0xIENBUkdPX05F",
  "VF9PRkZMSU5FPXRydWUgQ0FSR09fVEVS",
  "TV9DT0xPUj1uZXZlciBMQU5HPUMgTENf",
  "QUxMPUMgL3Vzci9sb2NhbC9jYXJnby9i",
  "aW4vY2FyZ28gdGVzdCAtLWxvY2tlZCAt",
  "LW9mZmxpbmUgLS1jb25maWcgbmV0Lm9m",
  "ZmxpbmU9dHJ1ZSAtLWNvbmZpZyAnc291",
  "cmNlLmNyYXRlcy1pby5yZXBsYWNlLXdp",
  "dGg9InZlbmRvcmVkLXNvdXJjZXMiJyAt",
  "LWNvbmZpZyAnc291cmNlLnZlbmRvcmVk",
  "LXNvdXJjZXMuZGlyZWN0b3J5PSIvaW5w",
  "dXQvdmVuZG9yIicgLS1tYW5pZmVzdC1w",
  "YXRoIC9pbnB1dC9zb3VyY2UvdG9vbHMv",
  "aG9zdGVkLW1pZ3JhdGlvbi1yb290LWF1",
  "dGhvcml0eS9DYXJnby50b21sIC0tbm8t",
  "ZGVmYXVsdC1mZWF0dXJlcyAtLWZlYXR1",
  "cmVzIHdwMjAxLWludGVybmFsIGF1dGhv",
  "cml0eV9yZWdpc3RyeV90ZXN0czo6d3Ay",
  "MDFfcm9vdF9jb250YWluZXJfYnJpZGdl",
  "X3N1Y2Nlc3MgLS0gLS1pZ25vcmVkIC0t",
  "ZXhhY3QgLS1ub2NhcHR1cmUgOzsKICAq",
  "KSBmYWxzZSA7Owplc2FjCmNhcmdvX3N0",
  "YXR1cz0kPwpzZXQgLWUKCnZlcmlmeV9p",
  "bnB1dHMgYWZ0ZXIKdmVyaWZ5X25hbWVz",
  "cGFjZXNfc3RhYmxlCmV4aXQgIiRjYXJn",
  "b19zdGF0dXMiCg==",
]).join("");

const ACQUISITION_CONTROLLER = decodeController(
  ACQUISITION_CONTROLLER_BASE64,
  ACQUISITION_CONTROLLER_LENGTH,
  ACQUISITION_CONTROLLER_SHA256,
);
const PROOF_CONTROLLER = decodeController(
  PROOF_CONTROLLER_BASE64,
  PROOF_CONTROLLER_LENGTH,
  PROOF_CONTROLLER_SHA256,
);

const PACKAGE_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const VITEST_ENTRY = fileURLToPath(
  new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url),
);
const DOCKER_INTEGRATION = fileURLToPath(
  new URL("./docker-integration.mjs", import.meta.url),
);
const ACQUISITION_FIXTURE = new URL(
  "../../../docs/design/wp201-controller-fixtures/acquisition-controller.sh",
  import.meta.url,
);
const PROOF_FIXTURE = new URL(
  "../../../docs/design/wp201-controller-fixtures/proof-controller.sh",
  import.meta.url,
);

const CHILD_ENVIRONMENT = Object.freeze({
  PATH: "/usr/bin:/bin",
  LANG: "C",
  LC_ALL: "C",
});
const MAX_DIAGNOSTIC_BYTES = 16 * 1024 * 1024;
const VITEST_DEADLINE_MILLISECONDS = 120_000;
const DOCKER_INTEGRATION_DEADLINE_MILLISECONDS = 2_400_000;
const TERM_SETTLEMENT_MILLISECONDS = 2_000;
const KILL_SETTLEMENT_MILLISECONDS = 3_000;
const GROUP_ABSENCE_POLL_MILLISECONDS = 50;
const DEADLINE_POLL_MILLISECONDS = 50;
const OUTPUT_SETTLEMENT_MILLISECONDS = 5_000;
const MAXIMUM_UPTIME_BYTES = 128;
const MAXIMUM_UPTIME_FRACTION_DIGITS = 9;
const UPTIME_PATH = "/proc/uptime";
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;
const NANOSECONDS_PER_SECOND = 1_000_000_000n;
const CHILD_SETTLEMENT_REFUSAL = Buffer.from(
  "openspell.wp201.child-settlement-timeout.v1\n",
  "ascii",
);
const ORCHESTRATOR_REFUSAL = Buffer.from(
  "openspell.wp201.test-orchestrator-failed.v1\n",
  "ascii",
);

function refuse(reason) {
  throw new Error(`WP-201 test orchestrator refused: ${reason}`);
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeController(base64, length, sha256) {
  const bytes = Buffer.from(base64, "base64");
  if (
    bytes.length !== length ||
    bytes.toString("base64") !== base64 ||
    digest(bytes) !== sha256 ||
    bytes.at(-1) !== 0x0a
  ) {
    refuse("embedded controller identity mismatch");
  }
  return bytes;
}

function modeOf(stats) {
  return Number(stats.mode & 0o7777n);
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function requireDirectory(stats, expected, reason) {
  if (
    !stats.isDirectory() ||
    !sameIdentity(stats, expected) ||
    stats.uid !== expected.uid ||
    stats.gid !== expected.gid ||
    stats.dev !== expected.dev ||
    modeOf(stats) !== 0o700
  ) {
    refuse(reason);
  }
}

function requireFile(stats, expected, length, reason) {
  if (
    !stats.isFile() ||
    !sameIdentity(stats, expected) ||
    stats.uid !== expected.uid ||
    stats.gid !== expected.gid ||
    stats.dev !== expected.dev ||
    stats.nlink !== 1n ||
    stats.size !== BigInt(length) ||
    modeOf(stats) !== 0o444
  ) {
    refuse(reason);
  }
}

async function validateControlDirectory(controlDirectory) {
  if (
    controlDirectory === null ||
    typeof controlDirectory !== "object" ||
    !Number.isInteger(controlDirectory.fd) ||
    controlDirectory.fd < 0 ||
    typeof controlDirectory.stat !== "function"
  ) {
    refuse("control destination is not an open directory handle");
  }
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    refuse("invoking identity is unavailable");
  }
  const held = await controlDirectory.stat({ bigint: true });
  const root = `/proc/self/fd/${controlDirectory.fd}`;
  const reached = await stat(root, { bigint: true });
  if (
    !held.isDirectory() ||
    !sameIdentity(held, reached) ||
    held.uid !== BigInt(process.getuid()) ||
    held.gid !== BigInt(process.getgid()) ||
    held.dev !== reached.dev ||
    modeOf(held) !== 0o700 ||
    modeOf(reached) !== 0o700
  ) {
    refuse("control destination identity mismatch");
  }
  return Object.freeze({ expected: held, root });
}

async function revalidateControlDirectory(base) {
  const current = await stat(base.root, { bigint: true });
  requireDirectory(current, base.expected, "control destination changed");
}

async function writeAll(file, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await file.write(bytes, offset, bytes.length - offset, null);
    if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0) {
      refuse("controller write did not advance");
    }
    offset += result.bytesWritten;
  }
}

async function writeController(base, name, bytes, expectedSha256) {
  await revalidateControlDirectory(base);
  const pathname = `${base.root}/${name}`;
  let file;
  let identity;
  try {
    file = await open(
      pathname,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    identity = await file.stat({ bigint: true });
    if (
      !identity.isFile() ||
      identity.dev !== base.expected.dev ||
      identity.uid !== base.expected.uid ||
      identity.gid !== base.expected.gid ||
      identity.nlink !== 1n ||
      identity.size !== 0n
    ) {
      refuse("new controller identity mismatch");
    }
    await writeAll(file, bytes);
    await file.chmod(0o444);
    await file.sync();
    const complete = await file.stat({ bigint: true });
    requireFile(
      complete,
      identity,
      bytes.length,
      "completed controller identity mismatch",
    );
  } finally {
    if (file !== undefined) await file.close();
  }

  const closed = await lstat(pathname, { bigint: true });
  requireFile(closed, identity, bytes.length, "closed controller identity mismatch");
  let verification;
  try {
    verification = await open(
      pathname,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const reopened = await verification.stat({ bigint: true });
    requireFile(reopened, identity, bytes.length, "reopened controller identity mismatch");
    const written = await verification.readFile();
    if (!written.equals(bytes) || digest(written) !== expectedSha256) {
      refuse("written controller bytes mismatch");
    }
  } finally {
    if (verification !== undefined) await verification.close();
  }
  await revalidateControlDirectory(base);
  return Object.freeze({
    name,
    bytes: bytes.length,
    sha256: expectedSha256,
  });
}

/**
 * Exclusively stages the two embedded controllers beneath an already-open,
 * invoking-user-owned mode-0700 control directory.
 */
export async function writeControllerFiles({ controlDirectory } = {}) {
  const base = await validateControlDirectory(controlDirectory);
  const acquisition = await writeController(
    base,
    "acquisition.sh",
    ACQUISITION_CONTROLLER,
    ACQUISITION_CONTROLLER_SHA256,
  );
  const proof = await writeController(
    base,
    "proof.sh",
    PROOF_CONTROLLER,
    PROOF_CONTROLLER_SHA256,
  );
  return Object.freeze({ acquisition, proof });
}

/**
 * Byte-compares the embedded controller constants to the two fixed reviewed
 * design fixtures. It accepts no fixture path.
 */
export async function verifyControllerFixtures() {
  const [acquisition, proof] = await Promise.all([
    readFile(ACQUISITION_FIXTURE),
    readFile(PROOF_FIXTURE),
  ]);
  if (
    !acquisition.equals(ACQUISITION_CONTROLLER) ||
    acquisition.length !== ACQUISITION_CONTROLLER_LENGTH ||
    digest(acquisition) !== ACQUISITION_CONTROLLER_SHA256
  ) {
    refuse("acquisition controller fixture mismatch");
  }
  if (
    !proof.equals(PROOF_CONTROLLER) ||
    proof.length !== PROOF_CONTROLLER_LENGTH ||
    digest(proof) !== PROOF_CONTROLLER_SHA256
  ) {
    refuse("proof controller fixture mismatch");
  }
  return Object.freeze({
    acquisition: Object.freeze({
      bytes: ACQUISITION_CONTROLLER_LENGTH,
      sha256: ACQUISITION_CONTROLLER_SHA256,
    }),
    proof: Object.freeze({
      bytes: PROOF_CONTROLLER_LENGTH,
      sha256: PROOF_CONTROLLER_SHA256,
    }),
  });
}

function captureStream(stream, state, requestTermination) {
  stream.on("data", (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    state.total += bytes.length;
    const remaining = MAX_DIAGNOSTIC_BYTES - state.kept;
    if (remaining > 0) {
      const retained = bytes.subarray(0, Math.min(remaining, bytes.length));
      state.chunks.push(Buffer.from(retained));
      state.kept += retained.length;
    }
    if (state.total > MAX_DIAGNOSTIC_BYTES && !state.overflow) {
      state.overflow = true;
      requestTermination();
    }
  });
}

function parseBootTimeNanoseconds(bytes) {
  if (bytes.length === 0 || bytes.length > MAXIMUM_UPTIME_BYTES) {
    refuse("boot-time sample size");
  }
  for (const byte of bytes) {
    if (byte > 0x7f) refuse("boot-time sample encoding");
  }

  let position = 0;
  function parseField(terminator) {
    if (position >= bytes.length) refuse("boot-time sample framing");
    let seconds = 0n;
    if (bytes[position] === 0x30) {
      position += 1;
      if (
        position < bytes.length &&
        bytes[position] >= 0x30 &&
        bytes[position] <= 0x39
      ) {
        refuse("boot-time sample leading zero");
      }
    } else {
      if (bytes[position] < 0x31 || bytes[position] > 0x39) {
        refuse("boot-time sample seconds");
      }
      while (
        position < bytes.length &&
        bytes[position] >= 0x30 &&
        bytes[position] <= 0x39
      ) {
        seconds = seconds * 10n + BigInt(bytes[position] - 0x30);
        position += 1;
      }
    }

    let fraction = 0n;
    let fractionDigits = 0;
    if (bytes[position] === 0x2e) {
      position += 1;
      while (
        position < bytes.length &&
        bytes[position] >= 0x30 &&
        bytes[position] <= 0x39
      ) {
        if (fractionDigits === MAXIMUM_UPTIME_FRACTION_DIGITS) {
          refuse("boot-time sample fraction cap");
        }
        fraction = fraction * 10n + BigInt(bytes[position] - 0x30);
        fractionDigits += 1;
        position += 1;
      }
      if (fractionDigits === 0) refuse("boot-time sample fraction");
    }
    if (bytes[position] !== terminator) refuse("boot-time sample delimiter");
    position += 1;
    while (fractionDigits < MAXIMUM_UPTIME_FRACTION_DIGITS) {
      fraction *= 10n;
      fractionDigits += 1;
    }
    return seconds * NANOSECONDS_PER_SECOND + fraction;
  }

  const bootTime = parseField(0x20);
  parseField(0x0a);
  if (position !== bytes.length) refuse("boot-time sample trailing bytes");
  return bootTime;
}

async function openBootTimeClock() {
  let file;
  try {
    file = await open(UPTIME_PATH, constants.O_RDONLY | constants.O_NOFOLLOW);
    const identity = await file.stat({ bigint: true });
    if (
      !identity.isFile() ||
      identity.nlink !== 1n ||
      identity.size !== 0n ||
      identity.uid !== 0n ||
      identity.gid !== 0n ||
      modeOf(identity) !== 0o444
    ) {
      refuse("boot-time descriptor identity");
    }

    let closed = false;
    let previous;
    const clock = Object.freeze({
      sample() {
        if (closed) refuse("boot-time descriptor closed");
        const buffer = Buffer.allocUnsafe(MAXIMUM_UPTIME_BYTES + 1);
        const bytesRead = readSync(file.fd, buffer, 0, buffer.length, 0);
        if (
          !Number.isSafeInteger(bytesRead) ||
          bytesRead <= 0 ||
          bytesRead > MAXIMUM_UPTIME_BYTES
        ) {
          refuse("boot-time sample cap");
        }
        const value = parseBootTimeNanoseconds(buffer.subarray(0, bytesRead));
        if (previous !== undefined && value < previous) {
          refuse("boot-time clock regressed");
        }
        previous = value;
        return value;
      },
      async close() {
        if (closed) return;
        closed = true;
        await file.close();
      },
    });
    clock.sample();
    return clock;
  } catch (error) {
    if (file !== undefined) {
      try {
        await file.close();
      } catch {
        // Preserve the original clock refusal.
      }
    }
    throw error;
  }
}

function absoluteDeadline(clock, milliseconds) {
  return clock.sample() + BigInt(milliseconds) * NANOSECONDS_PER_MILLISECOND;
}

function spawnFailureResult() {
  return Object.freeze({
    status: null,
    signal: null,
    spawnFailed: true,
    deadlineExpired: false,
    settlementTimedOut: false,
    processGroupResidual: false,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    stdoutOverflow: false,
    stderrOverflow: false,
  });
}

function observeOwnedChild(child, clock, deadlineNanoseconds) {
  const stdout = { chunks: [], kept: 0, overflow: false, total: 0 };
  const stderr = { chunks: [], kept: 0, overflow: false, total: 0 };
  let closed = false;
  let finished = false;
  let spawnFailed = false;
  let deadlineExpired = false;
  let settlementTimedOut = false;
  let processGroupResidual = false;
  let status = null;
  let exitSignal = null;
  let groupAbsenceConfirmed = false;
  let deadlineTimer;
  let absenceTimer;
  let termDeadlineNanoseconds;
  let killDeadlineNanoseconds;
  let killSent = false;
  let finish;
  const completed = new Promise((resolve) => {
    finish = resolve;
  });

  function clearTimers() {
    clearTimeout(deadlineTimer);
    clearTimeout(absenceTimer);
  }

  function completeIfSettled() {
    if (finished || !closed || !groupAbsenceConfirmed) return;
    finished = true;
    clearTimers();
    finish({
      status,
      signal: exitSignal,
      spawnFailed,
      deadlineExpired,
      settlementTimedOut,
      processGroupResidual,
      stdout: Buffer.concat(stdout.chunks),
      stderr: Buffer.concat(stderr.chunks),
      stdoutOverflow: stdout.overflow,
      stderrOverflow: stderr.overflow,
    });
  }

  function signalGroup(signal) {
    if (!Number.isInteger(child.pid) || child.pid <= 0) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") spawnFailed = true;
    }
  }

  function groupIsAbsent() {
    if (!Number.isInteger(child.pid) || child.pid <= 0) return true;
    try {
      process.kill(-child.pid, 0);
      return false;
    } catch (error) {
      if (error?.code === "ESRCH") return true;
      spawnFailed = true;
      return false;
    }
  }

  function scheduleAbsenceProbe() {
    if (finished || groupAbsenceConfirmed || absenceTimer !== undefined) return;
    absenceTimer = setTimeout(() => {
      absenceTimer = undefined;
      probeGroupAbsence();
    }, GROUP_ABSENCE_POLL_MILLISECONDS);
  }

  function probeGroupAbsence() {
    if (finished || groupAbsenceConfirmed) return;
    if (groupIsAbsent()) {
      groupAbsenceConfirmed = true;
      completeIfSettled();
      return;
    }
    if (closed && !terminationRequested) {
      processGroupResidual = true;
      requestTermination();
    }
    if (closed || terminationRequested) scheduleAbsenceProbe();
  }

  let terminationRequested = false;
  function refuseExceptionalSettlement() {
    settlementTimedOut = true;
    processGroupResidual = true;
    signalGroup("SIGKILL");
    try {
      writeSync(2, CHILD_SETTLEMENT_REFUSAL);
    } catch {
      // Refusal is already latched even when the diagnostic peer is gone.
    }
    process.exit(1);
  }

  function sampleOrRefuse() {
    try {
      return clock.sample();
    } catch {
      spawnFailed = true;
      refuseExceptionalSettlement();
      return 0n;
    }
  }

  function requestTermination(sampledAt) {
    if (terminationRequested || finished) return;
    terminationRequested = true;
    const now = sampledAt ?? sampleOrRefuse();
    signalGroup("SIGTERM");
    termDeadlineNanoseconds =
      now + BigInt(TERM_SETTLEMENT_MILLISECONDS) * NANOSECONDS_PER_MILLISECOND;
    sampleOrRefuse();
  }

  function pollDeadlines() {
    deadlineTimer = undefined;
    if (finished) return;
    const now = sampleOrRefuse();
    if (now >= deadlineNanoseconds) {
      deadlineExpired = true;
      requestTermination(now);
    }
    if (
      terminationRequested &&
      !killSent &&
      termDeadlineNanoseconds !== undefined &&
      now >= termDeadlineNanoseconds
    ) {
      signalGroup("SIGKILL");
      killSent = true;
      killDeadlineNanoseconds =
        now + BigInt(KILL_SETTLEMENT_MILLISECONDS) * NANOSECONDS_PER_MILLISECOND;
      sampleOrRefuse();
    } else if (
      killSent &&
      killDeadlineNanoseconds !== undefined &&
      now >= killDeadlineNanoseconds
    ) {
      refuseExceptionalSettlement();
      return;
    }
    deadlineTimer = setTimeout(pollDeadlines, DEADLINE_POLL_MILLISECONDS);
  }

  captureStream(child.stdout, stdout, requestTermination);
  captureStream(child.stderr, stderr, requestTermination);

  child.once("error", () => {
    spawnFailed = true;
    requestTermination();
  });
  child.once("close", (childStatus, signal) => {
    if (closed) return;
    const now = sampleOrRefuse();
    closed = true;
    status = childStatus;
    exitSignal = signal;
    if (now >= deadlineNanoseconds) deadlineExpired = true;
    sampleOrRefuse();
    probeGroupAbsence();
  });

  pollDeadlines();

  return Object.freeze({ completed, requestTermination });
}

let activeChildControl;
let activeOutputControl;
let caughtSignal;

function catchSignal(signal) {
  if (caughtSignal !== undefined) return;
  caughtSignal = signal;
  activeChildControl?.requestTermination();
  activeOutputControl?.requestTermination();
}

async function runFixedVitest(clock) {
  if (caughtSignal !== undefined) return spawnFailureResult();
  const deadline = absoluteDeadline(clock, VITEST_DEADLINE_MILLISECONDS);
  let child;
  try {
    child = spawn(
      process.execPath,
      [
        VITEST_ENTRY,
        "run",
        "src/boundary.test.ts",
        "src/composition.test.ts",
        "src/interruption.test.ts",
      ],
      {
        cwd: PACKAGE_DIRECTORY,
        env: CHILD_ENVIRONMENT,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch {
    return spawnFailureResult();
  }
  const control = observeOwnedChild(child, clock, deadline);
  activeChildControl = control;
  if (caughtSignal !== undefined) control.requestTermination();
  const result = await control.completed;
  if (activeChildControl === control) activeChildControl = undefined;
  return Object.freeze(result);
}

async function runFixedDockerIntegration(clock) {
  if (caughtSignal !== undefined) return spawnFailureResult();
  const deadline = absoluteDeadline(
    clock,
    DOCKER_INTEGRATION_DEADLINE_MILLISECONDS,
  );
  let child;
  try {
    child = spawn(process.execPath, [DOCKER_INTEGRATION], {
      cwd: PACKAGE_DIRECTORY,
      env: CHILD_ENVIRONMENT,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return spawnFailureResult();
  }
  const control = observeOwnedChild(child, clock, deadline);
  activeChildControl = control;
  if (caughtSignal !== undefined) control.requestTermination();
  const result = await control.completed;
  if (activeChildControl === control) activeChildControl = undefined;
  return Object.freeze(result);
}

function succeeded(result) {
  return (
    result.status === 0 &&
    result.signal === null &&
    !result.spawnFailed &&
    !result.deadlineExpired &&
    !result.settlementTimedOut &&
    !result.processGroupResidual &&
    !result.stdoutOverflow &&
    !result.stderrOverflow
  );
}

async function writeCaptured(stream, bytes, clock, deadlineNanoseconds) {
  if (
    caughtSignal !== undefined ||
    clock.sample() >= deadlineNanoseconds
  ) {
    throw new Error("WP-201 captured output refused before write");
  }
  if (bytes.length === 0) return;
  await new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const control = Object.freeze({ requestTermination });

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (activeOutputControl === control) activeOutputControl = undefined;
      if (error === undefined) resolve();
      else reject(error);
    }

    function requestTermination() {
      if (settled) return;
      try {
        stream.destroy();
      } finally {
        finish(new Error("WP-201 captured output settlement refused"));
      }
    }

    function pollDeadline() {
      timer = undefined;
      if (settled) return;
      try {
        if (
          caughtSignal !== undefined ||
          clock.sample() >= deadlineNanoseconds
        ) {
          requestTermination();
          return;
        }
      } catch {
        requestTermination();
        return;
      }
      timer = setTimeout(pollDeadline, DEADLINE_POLL_MILLISECONDS);
    }

    activeOutputControl = control;
    timer = setTimeout(pollDeadline, DEADLINE_POLL_MILLISECONDS);
    try {
      stream.write(bytes, (error) => {
        if (error !== null && error !== undefined) {
          finish(error);
          return;
        }
        try {
          if (
            caughtSignal !== undefined ||
            clock.sample() >= deadlineNanoseconds
          ) {
            finish(new Error("WP-201 captured output deadline expired"));
            return;
          }
        } catch (sampleError) {
          finish(sampleError);
          return;
        }
        finish();
      });
    } catch (error) {
      finish(error);
    }
  });
}

/**
 * Exercises the private boot-time and captured-output invariants without
 * accepting a caller-selected path, clock, stream or deadline.
 */
export async function verifyTestOrchestratorRuntimeForTests() {
  if (
    caughtSignal !== undefined ||
    activeChildControl !== undefined ||
    activeOutputControl !== undefined
  ) {
    refuse("test-only orchestrator exercise while active");
  }

  if (
    parseBootTimeNanoseconds(Buffer.from("1.25 2.50\n", "ascii")) !==
    1_250_000_000n
  ) {
    refuse("test-only boot-time conversion");
  }
  for (const invalid of [
    "01.25 2.50\n",
    "1.1234567890 2.50\n",
    "1.25 2.50",
    "1.25  2.50\n",
    "1.25 2.50\nignored",
  ]) {
    let rejected = false;
    try {
      parseBootTimeNanoseconds(Buffer.from(invalid, "ascii"));
    } catch {
      rejected = true;
    }
    if (!rejected) refuse("test-only boot-time malformed acceptance");
  }

  const heldClock = await openBootTimeClock();
  let descriptorClosed = false;
  try {
    const before = heldClock.sample();
    const after = heldClock.sample();
    if (after < before) refuse("test-only boot-time regression");
  } finally {
    await heldClock.close();
  }
  try {
    heldClock.sample();
  } catch {
    descriptorClosed = true;
  }
  if (!descriptorClosed) refuse("test-only boot-time descriptor leak");

  let samples = 0;
  const advancingClock = Object.freeze({
    sample() {
      samples += 1;
      return samples === 1 ? 0n : 1n;
    },
  });
  const outputEvents = [];
  const blockedStream = Object.freeze({
    write() {
      outputEvents.push("write");
    },
    destroy() {
      outputEvents.push("destroy");
    },
  });
  let outputRefused = false;
  try {
    await writeCaptured(blockedStream, Buffer.from([0]), advancingClock, 1n);
  } catch {
    outputEvents.push("refuse");
    outputRefused = true;
  }
  if (
    !outputRefused ||
    outputEvents.length !== 3 ||
    outputEvents[0] !== "write" ||
    outputEvents[1] !== "destroy" ||
    outputEvents[2] !== "refuse" ||
    activeOutputControl !== undefined
  ) {
    refuse("test-only captured output settlement");
  }

  return Object.freeze({
    bootTimeParsing: true,
    descriptorClosed,
    capturedOutputDisposition: outputEvents.join(":"),
  });
}

async function emitResult(name, result, clock) {
  const deadline = absoluteDeadline(clock, OUTPUT_SETTLEMENT_MILLISECONDS);
  await writeCaptured(process.stdout, result.stdout, clock, deadline);
  await writeCaptured(process.stderr, result.stderr, clock, deadline);
  if (!succeeded(result)) {
    await writeCaptured(
      process.stderr,
      Buffer.from(`openspell.wp201.${name}-suite-failed.v1\n`, "ascii"),
      clock,
      deadline,
    );
  }
}

function directInvocation() {
  if (process.argv[1] === undefined) return false;
  try {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  } catch {
    return false;
  }
}

async function main() {
  const signalHandlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const handler = () => catchSignal(signal);
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  let clock;
  try {
    clock = await openBootTimeClock();
    if (process.argv.length !== 2) refuse("arguments");
    if (caughtSignal !== undefined) {
      process.exitCode = 1;
      return;
    }
    await verifyControllerFixtures();
    if (caughtSignal !== undefined) {
      process.exitCode = 1;
      return;
    }

    const vitest = await runFixedVitest(clock);
    if (caughtSignal === undefined) {
      await emitResult("vitest", vitest, clock);
    }

    let docker;
    if (caughtSignal === undefined) {
      docker = await runFixedDockerIntegration(clock);
      if (caughtSignal === undefined) {
        await emitResult("docker-integration", docker, clock);
      }
    }

    if (
      caughtSignal !== undefined ||
      !succeeded(vitest) ||
      docker === undefined ||
      !succeeded(docker)
    ) {
      process.exitCode = 1;
    }
  } catch {
    process.exitCode = 1;
    if (clock !== undefined && caughtSignal === undefined) {
      try {
        const deadline = absoluteDeadline(
          clock,
          OUTPUT_SETTLEMENT_MILLISECONDS,
        );
        await writeCaptured(
          process.stderr,
          ORCHESTRATOR_REFUSAL,
          clock,
          deadline,
        );
      } catch {
        // The fixed refusal remains an exit failure if its peer cannot drain.
      }
    }
  } finally {
    activeOutputControl?.requestTermination();
    if (clock !== undefined) {
      try {
        await clock.close();
      } catch {
        process.exitCode = 1;
      }
    }
    if (caughtSignal !== undefined) process.exitCode = 1;
    for (const [signal, handler] of signalHandlers) {
      process.removeListener(signal, handler);
    }
  }
}

if (directInvocation()) {
  main().catch(() => {
    process.exitCode = 1;
  });
}

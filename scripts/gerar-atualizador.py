#!/usr/bin/env python3
"""Gera release/atualizar-nimber-atende-<versão>.ps1 com os arquivos alterados desde a v1.0.0 embutidos."""
import base64, json, subprocess, sys, os
root=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(root)
ver=json.load(open('package.json'))['version']
base=sys.argv[1] if len(sys.argv)>1 else 'v1.0.0'
files=[f for f in subprocess.check_output(['git','diff','--name-only',base,'HEAD']).decode().split() if not f.endswith('package-lock.json') and os.path.exists(f)]
entries='\n'.join(f'  "{f.replace("/", chr(92))}" = "{base64.b64encode(open(f,"rb").read()).decode()}"' for f in files)
t=open('scripts/atualizador-template.ps1',encoding='utf-8').read().replace('__VERSAO__',ver).replace('__ARQUIVOS__',entries)
os.makedirs('release',exist_ok=True)
out=f'release/atualizar-nimber-atende-{ver}.ps1'
open(out,'wb').write(b'\xef\xbb\xbf'+t.replace('\r\n','\n').replace('\n','\r\n').encode('utf-8'))
print(out, len(files), 'arquivos')

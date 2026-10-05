"""Fill docs/training-page.html with real numbers: python docs/build_page.py report-data.json OUT.html"""
import json
import sys

data = json.load(open(sys.argv[1]))
page = open("docs/training-page.html").read()
blob = json.dumps(data).replace("</", "<\\/")
open(sys.argv[2], "w").write(page.replace("__DATA__", blob))

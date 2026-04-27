test:
    python3 main.py | grep 00000 > output-python.txt
    bun main.js | grep 00000 > output-bun.txt
    node main.js | grep 00000 > output-node.txt

    diff output-python.txt output-bun.txt || true
    diff output-python.txt output-node.txt || true

clean:
    rm -rf .venv
    rm -rf node_modules

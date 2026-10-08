"""Catch typed resource failures while loading or running the owned ELF adapter.

Only this package's fixed sibling is executed; caller input stays in request.json.
Interpreter startup failures before this boundary remain unclassified.
"""
import os

try:
    implementation = os.path.join(os.path.dirname(__file__), "layout_impl.py")
    with open(implementation, "rb") as handle:
        source = handle.read()
    exec(compile(source, implementation, "exec"), {
        "__file__": implementation,
        "__name__": "__main__",
    })
except MemoryError:
    # Reserved status: an observed allocation failure, including imports/compile.
    os._exit(75)
except OSError as error:
    # Linux ENOMEM is an observed allocation failure, independent of error text.
    if error.errno == 12:
        os._exit(75)
    # Linux EFBIG is observed directly, including a partial limits/reply write.
    if error.errno == 27:
        os._exit(76)
    raise

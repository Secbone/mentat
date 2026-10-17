"""Load named pure upstream functions unchanged, with their exact source hash."""
import ast
import hashlib
from pathlib import Path


def load_function(path, name, namespace=None, class_name=None):
    path = Path(path)
    source = path.read_text()
    tree = ast.parse(source, filename=str(path))
    scope = tree.body
    if class_name:
        scope = next(node for node in scope if isinstance(node, ast.ClassDef) and node.name == class_name).body
    node = next(node for node in scope if isinstance(node, ast.FunctionDef) and node.name == name)
    module = ast.Module(body=[node], type_ignores=[])
    globals = dict(namespace or {})
    exec(compile(module, str(path), "exec"), globals)
    segment = ast.get_source_segment(source, node)
    return globals[name], hashlib.sha256(segment.encode()).hexdigest()

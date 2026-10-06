import numpy as np
import pytest

trimesh = pytest.importorskip("trimesh")

from arm_mia import surface  # noqa: E402


def two_sided_box() -> trimesh.Trimesh:
    """A box written the way TRELLIS.2 writes a shell: every face twice, once wound each way."""
    box = trimesh.creation.box(extents=(0.4, 1.8, 0.3))
    faces = np.vstack([box.faces, box.faces[:, ::-1]])
    return trimesh.Trimesh(box.vertices, faces, process=False)


def test_the_shell_is_closed_and_wraps_the_mesh():
    mesh = two_sided_box()
    shell = surface.outer_shell(mesh, resolution=64)
    assert shell.is_watertight
    assert shell.volume > 0
    np.testing.assert_allclose(shell.bounds, mesh.bounds, atol=1.8 / 64 * 1.5)


def test_normals_point_out_wherever_the_mesh_faced():
    mesh = two_sided_box()
    shell = surface.outer_shell(mesh, resolution=64)
    normals = surface.shell_normals(shell, mesh.vertices)
    outward = np.einsum("ij,ij->i", normals, mesh.vertices - mesh.vertices.mean(0))
    assert (outward > 0).all()


def test_a_closed_mesh_is_closed_even_split_along_seams():
    box = trimesh.creation.box()
    # Every face its own three vertices, as a mesh with UV seams everywhere is.
    split = trimesh.Trimesh(
        box.vertices[box.faces].reshape(-1, 3), np.arange(36).reshape(-1, 3), process=False
    )
    assert surface.is_closed(split)
    assert not surface.is_closed(two_sided_box().slice_plane([0, 0, 0], [0, 1, 0]))

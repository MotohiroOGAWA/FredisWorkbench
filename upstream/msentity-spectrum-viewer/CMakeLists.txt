cmake_minimum_required(VERSION 3.21)

# msentity-spectrum-viewer: viewer UI, its C++ backend, and the msentity
# libraries it is built on. As a subdirectory of another CMake project
# (for example through a Git submodule) this file also provides
#   msentity::msentity     (external/msentity)
#   msentity::similarity   (external/msentity-similarity)
project(msentity_spectrum_viewer
  VERSION 1.0.1
  DESCRIPTION "msentity spectrum viewer: UI, backend, and msentity libraries"
  LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
if(PROJECT_IS_TOP_LEVEL)
  set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
  if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
  endif()
endif()

option(MSENTITY_VIEWER_BUILD_BACKEND "Build msentity-viewer-backend (used by the VS Code extension)" ON)
option(MSENTITY_STATIC_DEPS
  "Link Arrow, Parquet, and HDF5 statically (self-contained backend for packaging)" OFF)

if(MSVC)
  add_compile_options(/utf-8)
  # A self-contained backend links the C++ runtime statically as well
  # (vcpkg triplet x64-windows-static).
  if(MSENTITY_STATIC_DEPS AND NOT DEFINED CMAKE_MSVC_RUNTIME_LIBRARY)
    set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
  endif()
endif()

# ---- msentity and msentity-similarity (Git submodules) ---------------------------------
foreach(_module msentity msentity-similarity)
  if(NOT EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/external/${_module}/CMakeLists.txt)
    message(FATAL_ERROR
      "external/${_module} is missing. Run: git submodule update --init --recursive")
  endif()
endforeach()

# The viewer only needs the C++ libraries. A project that includes this one
# can turn the C APIs (for Python/Java/C#) back on before add_subdirectory().
set(MSENTITY_BUILD_C_API OFF CACHE BOOL "Build msentity's C API library")
set(MSENTITY_SIMILARITY_BUILD_C_API OFF CACHE BOOL "Build msentity-similarity's C API library")

# msentity-similarity fetches msentity with FetchContent; point it at the
# submodule so that both use the same msentity sources.
if(NOT DEFINED FETCHCONTENT_SOURCE_DIR_MSENTITY)
  set(FETCHCONTENT_SOURCE_DIR_MSENTITY ${CMAKE_CURRENT_SOURCE_DIR}/external/msentity)
endif()
add_subdirectory(external/msentity-similarity)

# ---- backend -------------------------------------------------------------------------------
if(MSENTITY_VIEWER_BUILD_BACKEND)
  add_subdirectory(backend)
endif()

# msentity-viewer-backend: loads datasets and similarity results and answers the
# viewer's JSON requests on stdin/stdout (protocol: docs/protocol.md).

find_package(nlohmann_json 3 REQUIRED)

add_executable(msentity-viewer-backend
  src/main.cpp
  src/json_support.cpp
  src/view.cpp
  src/dataset_backend.cpp
  src/similarity_backend.cpp)
target_link_libraries(msentity-viewer-backend PRIVATE
  msentity::similarity msentity::msentity nlohmann_json::nlohmann_json)
target_compile_definitions(msentity-viewer-backend PRIVATE
  MSENTITY_VIEWER_VERSION="${PROJECT_VERSION}")
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(msentity-viewer-backend PRIVATE -Wall -Wextra)
endif()
if(MSENTITY_STATIC_DEPS AND CMAKE_CXX_COMPILER_ID STREQUAL "GNU")
  target_link_options(msentity-viewer-backend PRIVATE -static-libstdc++ -static-libgcc)
endif()

install(TARGETS msentity-viewer-backend RUNTIME DESTINATION bin)

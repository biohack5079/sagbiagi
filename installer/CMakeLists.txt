cmake_minimum_required(VERSION 3.15)
project(sagbi_installer LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)

add_executable(sagbi_install WIN32
    sagbi_installer.cpp
)

target_link_libraries(sagbi_install PRIVATE
    shell32
    urlmon
    user32
)

# Static link for portable .exe
if(MINGW)
    target_link_options(sagbi_install PRIVATE -static)
endif()

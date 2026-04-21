import os
print(os.getcwd())
print(os.chdir('C:'))#改变工作目录
print(os.listdir("C:"))#列出目录下的文件
print(os.mkdir("C:/", 1))#创建单个目录
print(os.mkdirs())#创建多级目录
print(os.rmdir())#删除空目录
print(os.removedirs)#递归删除文件夹（目录），必须都是空目录
print(os.rename())#重命名
input()

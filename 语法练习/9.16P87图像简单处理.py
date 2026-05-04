from PIL import Image
import numpy as np
import matplotlib.pyplot as plt
'''
Image:对图像的基本操作，打开图像文件等
numpy:对图像的每一个像素的RGB值以矩阵形式存储
matplotlib.pyplot:调整后生成新图像
'''
img=np.(Image.open('1.jpg').convert('L'))
#打开图像并转换成数字矩阵
rows,cols=img.shape			#图像尺寸分别赋值
for i in range(rows):
	for j in range(cols):
		if (img[i,j]>128):
			img[i,j]=1
		else:
			img[i,j]=0

plt.figure('lena')				#指定当前绘图对象
plt.imshow(img,cmap='gray')		#显示灰度图像
plt.axis('off')					#关闭图像坐标
plt.show()						#弹出包含了图片的窗口

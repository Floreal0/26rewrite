import os

#字符串索引值从左往右：0开始计数，step =1
#字符串索引值从右往左：-1开始计数，step =-1
'''
.index    查询位置
.reverse    反转列表
sum()    列表求和
'''

#集合运算
A=set('1234')
B=set('357')
print (A|B)#联集
print (A&B)#交集
print (A-B)#A-B差集
print (B-A)#B-A差集
print(A^B)#互斥

#递归算法实现阶乘
def factR(x):
    if x<=1:
        return 1
    elsereturn(x*factR(x-1))

fac=int(input("阶乘"))


os.pause()

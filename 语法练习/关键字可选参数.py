def keyFunc(**kwargs):
	print(kwargs)
	pass

dictA={"1":"a","2":"b"}
keyFunc(**dictA)
keyFunc(a=1,b=2)
keyFunc()

#可选参数必须放在关键字可选参数之前
